from __future__ import annotations

import json
import os
import re
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from typing import Any

try:
    from _supabase import find_entitlement
except ModuleNotFoundError:
    from api._supabase import find_entitlement


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ACTIVE_STATUSES = {"active", "trialing"}


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        try:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            email = normalize_email((params.get("email") or [""])[0])
            if not email:
                self.send_json({"detail": "Valid email is required"}, 400)
                return

            row = find_entitlement(email)
            if not row:
                self.send_json(free_payload(email))
                return

            payload = public_entitlement(row)
            self.send_json(payload)
        except Exception as exc:
            self.send_json({"detail": str(exc)}, 500)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", os.getenv("CORS_ORIGINS", "*"))
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def normalize_email(value: str) -> str:
    email = value.strip().lower()
    if not EMAIL_RE.match(email):
        return ""
    return email


def free_payload(email: str) -> dict[str, Any]:
    return {
        "email": email,
        "plan": "free",
        "status": "inactive",
        "lifetime": False,
        "current_period_end": None,
        "active": False,
    }


def public_entitlement(row: dict[str, Any]) -> dict[str, Any]:
    plan = str(row.get("plan") or "free")
    status = str(row.get("status") or "inactive")
    lifetime = bool(row.get("lifetime"))
    current_period_end = row.get("current_period_end")
    active = status in ACTIVE_STATUSES and (lifetime or period_is_current(current_period_end))
    return {
        "email": row.get("email"),
        "plan": plan,
        "status": status,
        "lifetime": lifetime,
        "current_period_end": current_period_end,
        "active": active,
        "updated_at": row.get("updated_at"),
    }


def period_is_current(value: Any) -> bool:
    if not value:
        return False
    if not isinstance(value, str):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed > datetime.now(timezone.utc)
