from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from typing import Any

try:
    from _supabase import insert_usage_event, save_entitlement
    from _email import send_manual_order_notification
except ModuleNotFoundError:
    from api._supabase import insert_usage_event, save_entitlement
    from api._email import send_manual_order_notification


HANDLED_EVENTS = {
    "transaction.completed",
    "subscription.created",
    "subscription.updated",
    "subscription.canceled",
    "subscription.past_due",
    "subscription.paused",
    "subscription.resumed",
}
ACTIVE_STATUSES = {"active", "trialing"}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_json({"ok": True, "route": "/api/paddle-webhook", "method": "POST only"})

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_POST(self) -> None:
        try:
            raw_body = self.read_raw_body()
            signature_header = self.headers.get("Paddle-Signature", "")
            if not verify_paddle_signature(raw_body, signature_header):
                self.send_json({"detail": "Invalid Paddle signature"}, 401)
                return

            event = json.loads(raw_body.decode("utf-8"))
            result = process_event(event)
            self.send_json({"ok": True, **result})
        except Exception as exc:
            self.send_json({"detail": str(exc)}, 500)

    def read_raw_body(self) -> bytes:
        length = int(self.headers.get("content-length", "0") or "0")
        return self.rfile.read(length) if length else b"{}"

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", os.getenv("CORS_ORIGINS", "*"))
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Paddle-Signature")

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def verify_paddle_signature(raw_body: bytes, signature_header: str) -> bool:
    secret = (os.getenv("PADDLE_WEBHOOK_SECRET") or "").strip()
    if not secret or not signature_header:
        return False

    timestamp, signatures = parse_signature_header(signature_header)
    if not timestamp or not signatures:
        return False

    tolerance = int(os.getenv("PADDLE_WEBHOOK_TOLERANCE_SECONDS", "300"))
    if tolerance > 0:
        try:
            sent_at = int(timestamp)
        except ValueError:
            return False
        if abs(int(time.time()) - sent_at) > tolerance:
            return False

    signed_payload = timestamp.encode("utf-8") + b":" + raw_body
    expected = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, signature) for signature in signatures)


def parse_signature_header(header: str) -> tuple[str, list[str]]:
    timestamp = ""
    signatures: list[str] = []
    for part in header.split(";"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key == "ts":
            timestamp = value
        elif key == "h1":
            signatures.append(value)
    return timestamp, signatures


def process_event(event: dict[str, Any]) -> dict[str, Any]:
    event_type = str(event.get("event_type") or "")
    if event_type not in HANDLED_EVENTS:
        return {"processed": False, "event_type": event_type}

    data = as_dict(event.get("data"))
    custom_data = as_dict(data.get("custom_data") or data.get("customData"))
    email = normalize_email(extract_email(data, custom_data))
    price_ids = collect_price_ids(data)
    manual_info = resolve_manual_service(price_ids)
    tip_info = resolve_author_tip(price_ids)
    plan_info = resolve_plan(price_ids)

    if tip_info and event_type == "transaction.completed":
        return process_author_tip(event, data, custom_data, email, price_ids, tip_info)
    if not email:
        return {"processed": False, "event_type": event_type, "detail": "missing email"}
    if manual_info and event_type == "transaction.completed":
        return process_manual_order(event, data, custom_data, email, price_ids, manual_info)
    if not plan_info:
        insert_usage_event(
            email,
            event_type,
            {
                "event_id": event.get("event_id"),
                "processed": False,
                "reason": "unrecognized price",
                "price_ids": price_ids,
            },
        )
        return {"processed": False, "event_type": event_type, "detail": "unrecognized price"}

    plan, lifetime = plan_info
    status = resolve_status(event_type, data)
    fields = {
        "plan": plan,
        "status": status,
        "lifetime": lifetime,
        "paddle_customer_id": first_text(data.get("customer_id"), custom_data.get("paddle_customer_id")),
        "paddle_subscription_id": subscription_id_for_event(event_type, data),
        "paddle_transaction_id": transaction_id_for_event(event_type, data),
        "current_period_end": current_period_end_for_plan(plan, lifetime, data),
    }
    saved = save_entitlement(email, fields)
    insert_usage_event(
        email,
        event_type,
        {
            "event_id": event.get("event_id"),
            "plan": plan,
            "status": status,
            "price_ids": price_ids,
            "paddle_customer_id": fields["paddle_customer_id"],
            "paddle_subscription_id": fields["paddle_subscription_id"],
            "paddle_transaction_id": fields["paddle_transaction_id"],
        },
    )
    return {
        "processed": True,
        "event_type": event_type,
        "email": email,
        "plan": saved.get("plan", plan),
        "status": saved.get("status", status),
    }


def process_manual_order(
    event: dict[str, Any],
    data: dict[str, Any],
    custom_data: dict[str, Any],
    email: str,
    price_ids: list[str],
    manual_info: dict[str, str],
) -> dict[str, Any]:
    quantity = parse_positive_int(custom_data.get("quantity")) or quantity_for_price(data, manual_info["price_id"]) or 1
    order = {
        "event_id": event.get("event_id"),
        "event_type": event.get("event_type"),
        "email": email,
        "plan": manual_info["plan"],
        "service_name": manual_info["service_name"],
        "unit_label": manual_info["unit_label"],
        "quantity": quantity,
        "details": clean_text(custom_data.get("details"), limit=1200),
        "price_ids": price_ids,
        "paddle_customer_id": first_text(data.get("customer_id"), custom_data.get("paddle_customer_id")),
        "paddle_transaction_id": transaction_id_for_event(str(event.get("event_type") or ""), data),
    }
    try:
        notify_result = send_manual_order_notification(order)
    except Exception as exc:
        notify_result = {"sent": False, "reason": f"notification error: {str(exc)[:300]}"}
    insert_usage_event(
        email,
        "manual_order.completed",
        {
            **order,
            "notification": notify_result,
        },
    )
    return {
        "processed": True,
        "event_type": str(event.get("event_type") or ""),
        "email": email,
        "plan": manual_info["plan"],
        "manual_order": True,
        "notification_sent": bool(notify_result.get("sent")),
    }


def process_author_tip(
    event: dict[str, Any],
    data: dict[str, Any],
    custom_data: dict[str, Any],
    email: str,
    price_ids: list[str],
    tip_info: dict[str, str],
) -> dict[str, Any]:
    quantity = parse_positive_int(custom_data.get("quantity"), max_value=999999) or quantity_for_price(data, tip_info["price_id"], max_value=999999) or 1
    amount_cny = quantity / 100
    insert_usage_event(
        email or "anonymous",
        "author_tip.completed",
        {
            "event_id": event.get("event_id"),
            "event_type": event.get("event_type"),
            "plan": tip_info["plan"],
            "amount_cny": amount_cny,
            "quantity": quantity,
            "price_ids": price_ids,
            "paddle_customer_id": first_text(data.get("customer_id"), custom_data.get("paddle_customer_id")),
            "paddle_transaction_id": transaction_id_for_event(str(event.get("event_type") or ""), data),
        },
    )
    return {
        "processed": True,
        "event_type": str(event.get("event_type") or ""),
        "email": email or None,
        "plan": tip_info["plan"],
        "author_tip": True,
        "amount_cny": amount_cny,
    }


def resolve_plan(price_ids: list[str]) -> tuple[str, bool] | None:
    price_map = {
        (os.getenv("PADDLE_PRICE_PRO_MONTHLY") or "").strip(): ("pro", False),
        (os.getenv("PADDLE_PRICE_LIFETIME") or "").strip(): ("lifetime", True),
        (os.getenv("PADDLE_PRICE_DAY_PASS") or "").strip(): ("day_pass", False),
    }
    for price_id in price_ids:
        plan = price_map.get(price_id)
        if plan:
            return plan
    return None


def resolve_manual_service(price_ids: list[str]) -> dict[str, str] | None:
    services = [
        (
            "PADDLE_PRICE_MANUAL_RECORDING_HOUR",
            "manual_recording",
            "人工代录制",
            "hour",
        ),
        (
            "PADDLE_PRICE_MANUAL_PPT_BASIC_PAGE",
            "manual_ppt_basic",
            "人工代改 PPT",
            "page",
        ),
        (
            "PADDLE_PRICE_MANUAL_PPT_PREMIUM_PAGE",
            "manual_ppt_premium",
            "大师级精修",
            "page",
        ),
    ]
    for env_key, plan, service_name, unit_label in services:
        price_id = (os.getenv(env_key) or "").strip()
        if price_id and price_id in price_ids:
            return {
                "price_id": price_id,
                "plan": plan,
                "service_name": service_name,
                "unit_label": unit_label,
            }
    return None


def resolve_author_tip(price_ids: list[str]) -> dict[str, str] | None:
    price_id = (os.getenv("PADDLE_PRICE_AUTHOR_TIP_CNY_CENT") or "").strip()
    if price_id and price_id in price_ids:
        return {
            "price_id": price_id,
            "plan": "author_tip",
        }
    return None


def resolve_status(event_type: str, data: dict[str, Any]) -> str:
    if event_type == "subscription.canceled":
        return "canceled"
    if event_type == "subscription.paused":
        return "paused"
    if event_type == "subscription.past_due":
        return "past_due"
    if event_type == "subscription.resumed":
        return "active"
    if event_type.startswith("subscription."):
        status = str(data.get("status") or "active").lower()
        return "active" if status in ACTIVE_STATUSES else status
    return "active"


def current_period_end_for_plan(plan: str, lifetime: bool, data: dict[str, Any]) -> str | None:
    if lifetime:
        return None

    period = as_dict(data.get("current_billing_period"))
    period_end = first_text(period.get("ends_at"), data.get("next_billed_at"), data.get("billing_period_end"))
    if period_end:
        return period_end

    if plan == "day_pass":
        return future_iso(days=1)
    if plan == "pro":
        return future_iso(days=31)
    return None


def future_iso(*, days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat().replace("+00:00", "Z")


def subscription_id_for_event(event_type: str, data: dict[str, Any]) -> str | None:
    if event_type.startswith("subscription."):
        return first_text(data.get("id"), data.get("subscription_id"))
    return first_text(data.get("subscription_id"))


def transaction_id_for_event(event_type: str, data: dict[str, Any]) -> str | None:
    if event_type.startswith("transaction."):
        return first_text(data.get("id"), data.get("transaction_id"))
    return first_text(data.get("transaction_id"))


def extract_email(data: dict[str, Any], custom_data: dict[str, Any]) -> str:
    customer = as_dict(data.get("customer"))
    billing = as_dict(data.get("billing_details"))
    candidates = [
        custom_data.get("email"),
        custom_data.get("customer_email"),
        data.get("customer_email"),
        data.get("email"),
        customer.get("email"),
        billing.get("email"),
    ]
    for value in candidates:
        text = first_text(value)
        if text:
            return text
    return ""


def normalize_email(value: str) -> str:
    email = value.strip().lower()
    if not EMAIL_RE.match(email):
        return ""
    return email


def collect_price_ids(value: Any) -> list[str]:
    found: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)
        elif isinstance(node, str) and node.startswith("pri_") and node not in found:
            found.append(node)

    walk(value)
    return found


def quantity_for_price(value: Any, price_id: str, *, max_value: int = 999) -> int | None:
    if isinstance(value, dict):
        price = as_dict(value.get("price"))
        current_price_id = first_text(price.get("id"), value.get("price_id"), value.get("priceId"))
        if current_price_id == price_id:
            quantity = parse_positive_int(value.get("quantity"), max_value=max_value)
            if quantity:
                return quantity
        for child in value.values():
            quantity = quantity_for_price(child, price_id, max_value=max_value)
            if quantity:
                return quantity
    elif isinstance(value, list):
        for child in value:
            quantity = quantity_for_price(child, price_id, max_value=max_value)
            if quantity:
                return quantity
    return None


def parse_positive_int(value: Any, *, max_value: int = 999) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    if number < 1:
        return None
    return min(number, max_value)


def clean_text(value: Any, *, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def first_text(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None
