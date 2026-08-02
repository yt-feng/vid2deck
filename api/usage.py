from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
import urllib.parse
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from http.server import BaseHTTPRequestHandler
from typing import Any

try:
    from _external_grant import resolve_external_benefit
    from _supabase import (
        find_sponsor_order_by_code,
        find_sponsor_order_by_request_id,
        insert_usage_event,
        list_recent_rows,
        list_sponsor_orders_by_email,
        list_usage_events,
        save_sponsor_order,
        update_sponsor_order,
        utc_now_iso,
    )
except ModuleNotFoundError:
    from api._external_grant import resolve_external_benefit
    from api._supabase import (
        find_sponsor_order_by_code,
        find_sponsor_order_by_request_id,
        insert_usage_event,
        list_recent_rows,
        list_sponsor_orders_by_email,
        list_usage_events,
        save_sponsor_order,
        update_sponsor_order,
        utc_now_iso,
    )


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{8,96}$")
PLAN_CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9-]{1,31}$")
CODE_RE = re.compile(r"^[A-Z0-9-]{8,40}$")
EVENT_RE = re.compile(r"^[a-z][a-z0-9_.-]{1,80}$")
ALLOWED_EVENTS = {"video_conversion", "editable_slide", "summary_generation", "transcribe_minute"}
ADMIN_USERNAME = os.getenv("VID2PPT_ADMIN_USERNAME", "twotigers_vid")
ADMIN_PASSWORD = os.getenv("VID2PPT_ADMIN_PASSWORD", "1108")
ADMIN_TOKEN_TTL_SECONDS = int(os.getenv("VID2PPT_ADMIN_TOKEN_TTL_SECONDS", str(7 * 24 * 60 * 60)))


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        try:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            action = str((params.get("action") or ["usage"])[0]).strip().lower()
            if action == "admin_data":
                admin = verify_admin_header(self.headers.get("authorization", ""))
                if not admin:
                    self.send_json({"detail": "Admin login required"}, 401)
                    return
                self.send_json(admin_payload(admin))
                return
            if action == "sponsor_code":
                request_id = clean_request_id((params.get("request_id") or [""])[0])
                if not request_id:
                    self.send_json({"detail": "Valid request_id is required"}, 400)
                    return
                order = find_sponsor_order_by_request_id(request_id)
                if not order:
                    self.send_json({"ok": True, "status": "pending", "code": None})
                    return
                self.send_json({"ok": True, **public_code_payload(order)})
                return
            if action == "sponsor_orders":
                email = normalize_email((params.get("email") or [""])[0])
                if not email:
                    self.send_json({"detail": "Valid email is required"}, 400)
                    return
                self.send_json(sponsor_orders_payload(email))
                return

            email = normalize_email((params.get("email") or [""])[0])
            if not email:
                self.send_json({"detail": "Valid email is required"}, 400)
                return
            self.send_json(usage_payload(email))
        except Exception as exc:
            self.send_json({"detail": str(exc)}, 500)

    def do_POST(self) -> None:
        try:
            data = self.read_json()
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            query_action = str((params.get("action") or [""])[0])
            action = str(data.get("action") or query_action or "record_usage").strip().lower()
            if action == "admin_login":
                self.handle_admin_login(data)
                return
            if action == "site_event":
                self.handle_site_event(data)
                return
            if action == "sponsor_order":
                self.handle_sponsor_order(data)
                return
            if action == "redeem_code":
                self.handle_redeem_code(data)
                return
            self.handle_record_usage(data)
        except ValueError:
            self.send_json({"detail": "Usage units must be an integer"}, 400)
        except Exception as exc:
            self.send_json({"detail": str(exc)}, 500)

    def handle_record_usage(self, data: dict[str, Any]) -> None:
        email = normalize_email(str(data.get("email") or ""))
        event_type = str(data.get("event_type") or "").strip()
        units = int(data.get("units") or 1)
        metadata = data.get("metadata")

        if not email:
            self.send_json({"detail": "Valid email is required"}, 400)
            return
        if event_type not in ALLOWED_EVENTS:
            self.send_json({"detail": "Unsupported usage event"}, 400)
            return
        if units < 1 or units > 100000:
            self.send_json({"detail": "Usage units out of range"}, 400)
            return
        if metadata is not None and not isinstance(metadata, dict):
            self.send_json({"detail": "metadata must be an object"}, 400)
            return

        insert_usage_event(email, event_type, metadata if isinstance(metadata, dict) else {}, units=units)
        self.send_json(usage_payload(email), 201)

    def handle_admin_login(self, data: dict[str, Any]) -> None:
        username = str(data.get("username") or "")
        password = str(data.get("password") or "")
        if not hmac.compare_digest(username, ADMIN_USERNAME) or not hmac.compare_digest(password, ADMIN_PASSWORD):
            self.send_json({"detail": "Invalid admin login"}, 401)
            return
        self.send_json({"token": create_admin_token(username), "username": username})

    def handle_site_event(self, data: dict[str, Any]) -> None:
        event_type = str(data.get("event_type") or "").strip().lower()
        if not EVENT_RE.match(event_type):
            self.send_json({"detail": "Unsupported event_type"}, 400)
            return

        email = normalize_email(str(data.get("email") or "")) or "anonymous"
        metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
        insert_usage_event(
            email,
            event_type,
            {
                "site_origin": "vid2ppt",
                **metadata,
                "path": clean_text(data.get("path"), 160),
                "visitor_id": clean_text(data.get("visitor_id"), 120),
                "user_agent": clean_text(self.headers.get("user-agent"), 300),
            },
        )
        self.send_json({"ok": True}, 201)

    def handle_sponsor_order(self, data: dict[str, Any]) -> None:
        request_id = clean_request_id(data.get("request_id"))
        if not request_id:
            self.send_json({"detail": "Valid request_id is required"}, 400)
            return

        plan_code = clean_plan_code(data.get("plan_code"))
        if not plan_code:
            self.send_json({"detail": "Valid plan_code is required"}, 400)
            return

        amount_cny = money_amount(data.get("amount_cny"))
        if amount_cny is None:
            self.send_json({"detail": "Valid amount_cny is required"}, 400)
            return

        email = normalize_email(str(data.get("email") or "")) or "anonymous"
        quantity = int((amount_cny * Decimal("100")).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
        external_config, external_plan = resolve_external_benefit(plan_code)
        linked_benefit = external_config is not None and external_plan is not None
        forwarded_for = self.headers.get("x-forwarded-for") or ""
        client_ip = forwarded_for.split(",", 1)[0].strip()
        if not client_ip and self.client_address:
            client_ip = self.client_address[0]
        payload = {
            "request_id": request_id,
            "email": email,
            "plan_code": plan_code,
            "status": "checkout_opened",
            "amount_cny": str(amount_cny),
            "requested_amount_cny": str(money_amount(data.get("requested_amount_cny")) or amount_cny),
            "quantity": quantity,
            "source": clean_text(data.get("source"), 80) or "sponsor_page",
            "site_origin": "vid2ppt",
            "benefit_site": external_config.benefit_site if linked_benefit else "vid2ppt",
            "benefit_plan": external_plan if linked_benefit else "redeem_code",
            "metadata": {
                "site_origin": "vid2ppt",
                "source_site": "vid2ppt",
                **metadata,
                "page": clean_text(data.get("page"), 160),
                "visitor_id": clean_text(data.get("visitor_id"), 120),
                "user_agent": clean_text(self.headers.get("user-agent"), 300),
                "ip": clean_text(client_ip, 120),
            },
        }
        order = save_sponsor_order(payload)
        insert_usage_event(
            email,
            "sponsor.checkout_opened",
            {
                "site_origin": "vid2ppt",
                "request_id": request_id,
                "plan_code": plan_code,
                "amount_cny": str(amount_cny),
                "quantity": quantity,
                "source": payload["source"],
            },
        )
        self.send_json({"ok": True, "order": public_sponsor_order(order)}, 201)

    def handle_redeem_code(self, data: dict[str, Any]) -> None:
        code = normalize_code(str(data.get("code") or ""))
        mode = str(data.get("mode") or "redeem").strip().lower()
        if mode not in {"check", "redeem"}:
            self.send_json({"detail": "Unsupported redeem mode"}, 400)
            return
        if not code:
            self.send_json({"valid": False, "detail": "Valid code is required"}, 400)
            return

        order = find_sponsor_order_by_code(code)
        if not order or str(order.get("status") or "") != "completed":
            self.send_json({"valid": False, "detail": "Code not found"})
            return

        email = normalize_email(str(data.get("email") or "")) or str(order.get("email") or "anonymous")
        source = clean_text(data.get("source"), 120) or "external"
        metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}

        if mode == "check":
            insert_usage_event(email, "sponsor_code.checked", {"code": code, "source": source, **metadata})
            self.send_json({"valid": True, "redeemed": bool(order.get("redeemed_at")), "order": public_redeem_order(order)})
            return

        if order.get("redeemed_at"):
            insert_usage_event(email, "sponsor_code.redeem_rejected", {"code": code, "source": source, "reason": "already_redeemed", **metadata})
            self.send_json({"valid": False, "redeemed": True, "detail": "Code already redeemed", "order": public_redeem_order(order)})
            return

        updated = update_sponsor_order(
            str(order.get("id")),
            {
                "redeemed_at": utc_now_iso(),
                "redeemed_by": email,
                "redeemed_source": source,
                "status": "completed",
            },
        )
        insert_usage_event(email, "sponsor_code.redeemed", {"code": code, "source": source, **metadata})
        self.send_json({"valid": True, "redeemed": True, "order": public_redeem_order({**order, **updated})})

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", os.getenv("CORS_ORIGINS", "*"))
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0") or "0")
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        parsed = json.loads(body or "{}")
        return parsed if isinstance(parsed, dict) else {}


def normalize_email(value: str) -> str:
    email = value.strip().lower()
    return email if EMAIL_RE.match(email) else ""


def usage_payload(email: str) -> dict[str, Any]:
    period_start = month_start_iso()
    events = list_usage_events(email, period_start)
    monthly: dict[str, int] = {}
    for event in events:
        event_type = str(event.get("event_type") or "")
        if event_type not in ALLOWED_EVENTS:
            continue
        units = int(event.get("units") or 0)
        monthly[event_type] = monthly.get(event_type, 0) + max(0, units)
    for event_type in ALLOWED_EVENTS:
        monthly.setdefault(event_type, 0)
    return {
        "email": email,
        "period": "monthly",
        "period_start": period_start,
        "monthly": monthly,
    }


def sponsor_orders_payload(email: str) -> dict[str, Any]:
    rows = list_sponsor_orders_by_email(email, limit=500)
    return {
        "ok": True,
        "email": email,
        "count": len(rows),
        "orders": [public_payment_record(row) for row in rows],
    }


def month_start_iso() -> str:
    now = datetime.now(timezone.utc)
    return datetime(now.year, now.month, 1, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def admin_secret() -> bytes:
    secret = os.getenv("AUTH_SECRET") or os.getenv("AUTH_CODE") or os.getenv("VID2PPT_ADMIN_SECRET") or ADMIN_PASSWORD
    return secret.strip().encode("utf-8")


def create_admin_token(username: str) -> str:
    payload = {"kind": "admin", "sub": username, "iat": int(time.time())}
    payload_bytes = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload_b64 = base64.urlsafe_b64encode(payload_bytes).decode("utf-8").rstrip("=")
    signature = hmac.new(admin_secret(), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{signature}"


def verify_admin_header(header: str) -> dict[str, Any] | None:
    prefix = "Bearer "
    if not header.startswith(prefix):
        return None
    token = header.removeprefix(prefix).strip()
    try:
        payload_b64, signature = token.split(".", 1)
    except ValueError:
        return None
    expected = hmac.new(admin_secret(), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return None
    padded = payload_b64 + "=" * (-len(payload_b64) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded.encode("utf-8")).decode("utf-8"))
    if payload.get("kind") != "admin":
        return None
    if not hmac.compare_digest(str(payload.get("sub") or ""), ADMIN_USERNAME):
        return None
    if int(time.time()) - int(payload.get("iat") or 0) > ADMIN_TOKEN_TTL_SECONDS:
        return None
    return payload


def admin_payload(admin: dict[str, Any]) -> dict[str, Any]:
    tables = {
        "sponsor_orders": table_result("sponsor_orders", limit=1000),
        "usage_events": table_result("usage_events", limit=1500),
        "user_entitlements": table_result("user_entitlements", limit=1000, order_column="updated_at"),
        "site_users": table_result(
            "site_users",
            select="id,username,email,email_is_generated,site_origin,registered_site,source_site,created_at,updated_at,last_login_at",
            limit=1000,
        ),
    }
    sponsor_rows = tables["sponsor_orders"]["rows"]
    return {
        "ok": True,
        "admin": {"username": admin.get("sub")},
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "summary": sponsor_summary(sponsor_rows),
        "tables": tables,
    }


def table_result(table: str, *, select: str = "*", limit: int = 500, order_column: str = "created_at") -> dict[str, Any]:
    try:
        rows = list_recent_rows(table, select=select, order_column=order_column, limit=limit)
        return {"rows": rows, "error": None}
    except Exception as exc:
        return {"rows": [], "error": str(exc)}


def sponsor_summary(rows: list[dict[str, Any]]) -> dict[str, int]:
    completed = 0
    checkout_opened = 0
    redeemed = 0
    for row in rows:
        status = str(row.get("status") or "")
        if status == "completed":
            completed += 1
        if status == "checkout_opened":
            checkout_opened += 1
        if row.get("redeemed_at"):
            redeemed += 1
    return {
        "sponsor_orders": len(rows),
        "checkout_opened": checkout_opened,
        "completed": completed,
        "redeemed": redeemed,
    }


def clean_request_id(value: Any) -> str:
    text = str(value or "").strip()
    return text if REQUEST_ID_RE.match(text) else ""


def clean_plan_code(value: Any) -> str:
    text = str(value or "").strip().upper()
    return text if PLAN_CODE_RE.match(text) else ""


def normalize_code(value: str) -> str:
    code = re.sub(r"\s+", "", value).strip().upper()
    return code if CODE_RE.match(code) else ""


def money_amount(value: Any) -> Decimal | None:
    try:
        amount = Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        return None
    if amount <= 0 or amount > Decimal("999999.00"):
        return None
    return amount


def clean_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


def public_sponsor_order(order: dict[str, Any]) -> dict[str, Any]:
    return {
        "request_id": order.get("request_id"),
        "email": order.get("email"),
        "plan_code": order.get("plan_code"),
        "status": order.get("status"),
        "amount_cny": order.get("amount_cny"),
        "site_origin": order.get("site_origin"),
        "benefit_site": order.get("benefit_site"),
        "benefit_plan": order.get("benefit_plan"),
        "created_at": order.get("created_at"),
        "updated_at": order.get("updated_at"),
    }


def public_code_payload(order: dict[str, Any]) -> dict[str, Any]:
    status = str(order.get("status") or "pending")
    completed = status == "completed" and bool(order.get("code"))
    return {
        "request_id": order.get("request_id"),
        "status": status,
        "completed": completed,
        "code": order.get("code") if completed else None,
        "plan_code": order.get("plan_code"),
        "amount_cny": order.get("amount_cny"),
        "benefit_site": order.get("benefit_site"),
        "benefit_plan": order.get("benefit_plan"),
        "redeemed_at": order.get("redeemed_at"),
        "completed_at": order.get("completed_at"),
        "updated_at": order.get("updated_at"),
    }


def public_payment_record(order: dict[str, Any]) -> dict[str, Any]:
    return {
        **public_code_payload(order),
        "created_at": order.get("created_at"),
        "paddle_transaction_id": order.get("paddle_transaction_id"),
        "source": order.get("source"),
    }


def public_redeem_order(order: dict[str, Any]) -> dict[str, Any]:
    return {
        "request_id": order.get("request_id"),
        "email": order.get("email"),
        "plan_code": order.get("plan_code"),
        "benefit_site": order.get("benefit_site"),
        "benefit_plan": order.get("benefit_plan"),
        "amount_cny": order.get("amount_cny"),
        "status": order.get("status"),
        "redeemed_at": order.get("redeemed_at"),
        "completed_at": order.get("completed_at"),
        "updated_at": order.get("updated_at"),
    }
