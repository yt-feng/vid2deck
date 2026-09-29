from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler
from typing import Any

try:
    from _auth import create_captcha_challenge
except ModuleNotFoundError:
    from api._auth import create_captcha_challenge


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        try:
            self.send_json({"ok": True, **create_captcha_challenge()})
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
