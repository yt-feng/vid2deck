from __future__ import annotations

import json
import os
import re
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from typing import Any

try:
    from _supabase import insert_usage_event, list_usage_events
except ModuleNotFoundError:
    from api._supabase import insert_usage_event, list_usage_events


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ALLOWED_EVENTS = {"video_conversion", "editable_slide", "transcribe_minute"}


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        try:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
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
        except ValueError:
            self.send_json({"detail": "Usage units must be an integer"}, 400)
        except Exception as exc:
            self.send_json({"detail": str(exc)}, 500)

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
    if not EMAIL_RE.match(email):
        return ""
    return email


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


def month_start_iso() -> str:
    now = datetime.now(timezone.utc)
    return datetime(now.year, now.month, 1, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
