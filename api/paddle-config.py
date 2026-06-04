from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler


PUBLIC_KEYS = [
    "PADDLE_ENV",
    "PADDLE_CLIENT_TOKEN",
    "PADDLE_PRICE_PRO_MONTHLY",
    "PADDLE_PRICE_LIFETIME",
    "PADDLE_PRICE_DAY_PASS",
    "PADDLE_PRICE_MANUAL_RECORDING_HOUR",
    "PADDLE_PRICE_MANUAL_PPT_BASIC_PAGE",
    "PADDLE_PRICE_MANUAL_PPT_PREMIUM_PAGE",
    "PADDLE_PRICE_AUTHOR_TIP_CNY_CENT",
]

REQUIRED_KEYS = [
    "PADDLE_CLIENT_TOKEN",
    "PADDLE_PRICE_PRO_MONTHLY",
    "PADDLE_PRICE_LIFETIME",
    "PADDLE_PRICE_DAY_PASS",
]


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        config = {key: (os.getenv(key) or "").strip() for key in PUBLIC_KEYS}
        config["PADDLE_ENV"] = config["PADDLE_ENV"] or "production"
        missing = [key for key in REQUIRED_KEYS if not config.get(key)]
        optional_missing = [key for key, value in config.items() if not value and key not in REQUIRED_KEYS and key != "PADDLE_ENV"]
        self.send_json({"config": config, "missing": missing, "optional_missing": optional_missing})

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", os.getenv("CORS_ORIGINS", "*"))
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
