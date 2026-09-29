from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from typing import Any

try:
    from _supabase import insert_usage_event, save_entitlement, save_sponsor_order, utc_now_iso
    from _email import send_manual_order_notification
except ModuleNotFoundError:
    from api._supabase import insert_usage_event, save_entitlement, save_sponsor_order, utc_now_iso
    from api._email import send_manual_order_notification


HANDLED_EVENTS = {
    "transaction.paid",
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
KCDESK_GIFT_PLAN_CODES = {"NOVA-3D", "NOVA-M", "NOVA-Q", "NOVA-Y", "NOVA-2Y"}


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
    manual_info = resolve_manual_service(price_ids, custom_data)
    tip_info = resolve_author_tip(price_ids)
    plan_info = resolve_plan(price_ids)

    if tip_info and event_type in {"transaction.paid", "transaction.completed"}:
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
        "site_origin": "vid2ppt",
        "source_site": "vid2ppt",
        "grant_source": "paddle",
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
            "site_origin": "vid2ppt",
            "source_site": "vid2ppt",
            "grant_source": "paddle",
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
        "billing_quantity": parse_positive_int(custom_data.get("billing_quantity"), max_value=999999)
        or quantity_for_price(data, manual_info["price_id"], max_value=999999),
        "unit_price_cents": parse_positive_int(custom_data.get("unit_price_cents"), max_value=999999),
        "amount_usd": clean_text(custom_data.get("amount_usd"), limit=40),
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
    transaction_id = transaction_id_for_event(str(event.get("event_type") or ""), data)
    request_id = clean_request_id(custom_data.get("request_id")) or f"paddle_{transaction_id or event.get('event_id') or int(time.time())}"
    plan_code = clean_plan_code(custom_data.get("plan_code")) or "SUPPORT"
    source = clean_text(custom_data.get("source"), limit=80) or "author_tip"
    benefit_site = "kcdesk" if is_kcdesk_gift_plan(plan_code) else "vid2ppt"
    benefit_plan = kcdesk_benefit_plan(plan_code) if is_kcdesk_gift_plan(plan_code) else "redeem_code"
    code = create_redeem_code(request_id, transaction_id or "", plan_code, quantity)
    completed_at = utc_now_iso()
    order_error = ""
    kcdesk_grant = grant_kcdesk_nova(
        email=email,
        plan_code=plan_code,
        request_id=request_id,
        transaction_id=transaction_id or "",
        event_id=str(event.get("event_id") or ""),
        completed_at=completed_at,
        amount_cny=f"{amount_cny:.2f}",
        quantity=quantity,
    )
    try:
        save_sponsor_order(
            {
                "request_id": request_id,
                "email": email or "anonymous",
                "plan_code": plan_code,
                "site_origin": "vid2ppt",
                "benefit_site": benefit_site,
                "benefit_plan": benefit_plan,
                "status": "completed",
                "code": code,
                "amount_cny": f"{amount_cny:.2f}",
                "requested_amount_cny": clean_text(custom_data.get("requested_amount_cny"), limit=40)
                or clean_text(custom_data.get("amount_cny"), limit=40)
                or f"{amount_cny:.2f}",
                "quantity": quantity,
                "source": source,
                "paddle_customer_id": first_text(data.get("customer_id"), custom_data.get("paddle_customer_id")),
                "paddle_transaction_id": transaction_id,
                "completed_at": completed_at,
                "metadata": {
                    "event_id": event.get("event_id"),
                    "event_type": event.get("event_type"),
                    "site_origin": "vid2ppt",
                    "source_site": "vid2ppt",
                    "legal_purchase_site": "vid2ppt.com",
                    "gift_benefit_site": "kcdesk.com" if benefit_site == "kcdesk" else "",
                    "price_ids": price_ids,
                    "custom_data": custom_data,
                    "kcdesk_grant": kcdesk_grant,
                },
            }
        )
    except Exception as exc:
        order_error = str(exc)[:500]

    paddle_event_type = str(event.get("event_type") or "")
    insert_usage_event(
        email or "anonymous",
        "author_tip.paid" if paddle_event_type == "transaction.paid" else "author_tip.completed",
        {
            "event_id": event.get("event_id"),
            "event_type": event.get("event_type"),
            "site_origin": "vid2ppt",
            "source_site": "vid2ppt",
            "plan": tip_info["plan"],
            "request_id": request_id,
            "plan_code": plan_code,
            "benefit_site": benefit_site,
            "benefit_plan": benefit_plan,
            "redeem_code": code,
            "amount_cny": amount_cny,
            "quantity": quantity,
            "price_ids": price_ids,
            "paddle_customer_id": first_text(data.get("customer_id"), custom_data.get("paddle_customer_id")),
            "paddle_transaction_id": transaction_id,
            "sponsor_order_error": order_error,
            "kcdesk_grant": kcdesk_grant,
        },
    )
    return {
        "processed": True,
        "event_type": str(event.get("event_type") or ""),
        "email": email or None,
        "plan": tip_info["plan"],
        "author_tip": True,
        "amount_cny": amount_cny,
        "redeem_code": code,
        "benefit_site": benefit_site,
        "kcdesk_grant": kcdesk_grant,
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


def resolve_manual_service(price_ids: list[str], custom_data: dict[str, Any]) -> dict[str, str] | None:
    shared_price_id = (os.getenv("PADDLE_PRICE_MANUAL_SERVICE_USD_CENT") or "").strip()
    requested_plan = first_text(custom_data.get("plan"))
    order_kind = first_text(custom_data.get("order_kind"), custom_data.get("orderKind"))
    if shared_price_id and shared_price_id in price_ids and order_kind == "manual_service" and requested_plan:
        for _, plan, service_name, unit_label in manual_services():
            if requested_plan == plan:
                return {
                    "price_id": shared_price_id,
                    "plan": plan,
                    "service_name": service_name,
                    "unit_label": unit_label,
                }

    for env_key, plan, service_name, unit_label in manual_services():
        price_id = (os.getenv(env_key) or "").strip()
        if price_id and price_id in price_ids:
            return {
                "price_id": price_id,
                "plan": plan,
                "service_name": service_name,
                "unit_label": unit_label,
            }
    return None


def manual_services() -> list[tuple[str, str, str, str]]:
    return [
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


def resolve_author_tip(price_ids: list[str]) -> dict[str, str] | None:
    price_id = (os.getenv("PADDLE_PRICE_AUTHOR_TIP_CNY_CENT") or "").strip()
    if price_id and price_id in price_ids:
        return {
            "price_id": price_id,
            "plan": "author_tip",
        }
    return None


def is_kcdesk_gift_plan(plan_code: str) -> bool:
    return clean_plan_code(plan_code) in KCDESK_GIFT_PLAN_CODES


def kcdesk_benefit_plan(plan_code: str) -> str:
    return "kcdesk_trial_3d" if clean_plan_code(plan_code) == "NOVA-3D" else "kcdesk_member"


def grant_kcdesk_nova(
    *,
    email: str,
    plan_code: str,
    request_id: str,
    transaction_id: str,
    event_id: str,
    completed_at: str,
    amount_cny: str,
    quantity: int,
) -> dict[str, Any]:
    if not email or not is_kcdesk_gift_plan(plan_code):
        return {"attempted": False, "ok": False, "reason": "not_nova_or_missing_email"}

    secret = (os.getenv("VID2PPT_KCDESK_GRANT_SECRET") or "").strip()
    if not secret:
        return {"attempted": False, "ok": False, "reason": "missing_secret"}

    url = (
        os.getenv("KCDESK_NOVA_GRANT_URL")
        or os.getenv("KCDESK_ATLAS_GRANT_URL")
        or "https://kcdesk.com/api/vid2ppt/nova-grant"
    ).strip()
    payload = {
        "email": email,
        "plan_code": clean_plan_code(plan_code),
        "request_id": request_id,
        "paddle_transaction_id": transaction_id,
        "event_id": event_id,
        "completed_at": completed_at,
        "amount_cny": amount_cny,
        "quantity": quantity,
        "legal_purchase_site": "vid2ppt.com",
        "gift_benefit_site": "kcdesk.com",
    }
    raw_body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(
        url,
        data=raw_body,
        method="POST",
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "Mozilla/5.0 (compatible; Vid2PPT-KCdesk-Grant/1.0; +https://vid2ppt.com)",
            "X-Vid2PPT-Signature": f"sha256={signature}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            body = response.read().decode("utf-8", errors="replace")
            data = json.loads(body) if body else {}
            return {
                "attempted": True,
                "ok": 200 <= response.status < 300 and bool(data.get("ok", True)),
                "status": response.status,
                "response": data,
            }
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return {"attempted": True, "ok": False, "status": exc.code, "response": body[:500]}
    except Exception as exc:
        return {"attempted": True, "ok": False, "status": 0, "response": str(exc)[:500]}


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


def clean_request_id(value: Any) -> str:
    text = clean_text(value, limit=96)
    if re.match(r"^[A-Za-z0-9._:-]{8,96}$", text):
        return text
    return ""


def clean_plan_code(value: Any) -> str:
    text = clean_text(value, limit=32).upper()
    if re.match(r"^[A-Z0-9][A-Z0-9-]{1,31}$", text):
        return text
    return ""


def create_redeem_code(request_id: str, transaction_id: str, plan_code: str, quantity: int) -> str:
    secret = (
        os.getenv("SPONSOR_CODE_SECRET")
        or os.getenv("PADDLE_WEBHOOK_SECRET")
        or os.getenv("AUTH_SECRET")
        or os.getenv("AUTH_CODE")
        or "vid2ppt-sponsor-code"
    )
    seed = f"{request_id}|{transaction_id}|{plan_code}|{quantity}".encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), seed, hashlib.sha256).hexdigest().upper()
    return f"V2D-{digest[0:4]}-{digest[4:8]}-{digest[8:12]}"


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def first_text(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None
