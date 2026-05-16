from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from http.server import BaseHTTPRequestHandler
from typing import Any

AUTH_USERNAME = os.getenv("AUTH_USERNAME", "admin")
AUTH_CODE = os.getenv("AUTH_CODE", "")
TOKEN_TTL_SECONDS = int(os.getenv("TOKEN_TTL_SECONDS", str(7 * 24 * 60 * 60)))


def signing_secret() -> bytes:
    secret = os.getenv("AUTH_SECRET") or os.getenv("DEEPSEEK_API_KEY") or AUTH_CODE
    if not secret:
        raise RuntimeError("AUTH_SECRET is not configured")
    return secret.encode("utf-8")


def create_token(username: str) -> str:
    payload = {"sub": username, "iat": int(time.time())}
    payload_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    payload_b64 = base64.urlsafe_b64encode(payload_bytes).decode("utf-8").rstrip("=")
    signature = hmac.new(signing_secret(), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{signature}"


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_POST(self) -> None:
        try:
            data = self.read_json()
            username = str(data.get("username", ""))
            access_code = str(data.get("access_code", ""))

            if not AUTH_CODE:
                self.send_json({"detail": "AUTH_CODE is not configured"}, 500)
                return
            if not hmac.compare_digest(username, AUTH_USERNAME):
                self.send_json({"detail": "Invalid login"}, 401)
                return
            if not hmac.compare_digest(access_code, AUTH_CODE):
                self.send_json({"detail": "Invalid login"}, 401)
                return

            self.send_json({"token": create_token(username)})
        except Exception as exc:
            self.send_json({"detail": str(exc)}, 500)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0") or "0")
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        return json.loads(body or "{}")

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", os.getenv("CORS_ORIGINS", "*"))
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
