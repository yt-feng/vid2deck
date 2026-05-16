from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from http.server import BaseHTTPRequestHandler
from typing import Any
from urllib.request import Request, urlopen

AUTH_USERNAME = os.getenv("AUTH_USERNAME", "admin")
TOKEN_TTL_SECONDS = int(os.getenv("TOKEN_TTL_SECONDS", str(7 * 24 * 60 * 60)))
DEEPSEEK_API_URL = os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com/chat/completions")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")


def signing_secret() -> bytes:
    secret = os.getenv("AUTH_SECRET") or os.getenv("DEEPSEEK_API_KEY") or os.getenv("AUTH_CODE", "")
    if not secret:
        raise RuntimeError("AUTH_SECRET is not configured")
    return secret.encode("utf-8")


def verify_token(token: str) -> str:
    try:
        payload_b64, signature = token.split(".", 1)
    except ValueError as exc:
        raise RuntimeError("Invalid token") from exc

    expected = hmac.new(signing_secret(), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise RuntimeError("Invalid token")

    padded = payload_b64 + "=" * (-len(payload_b64) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded.encode("utf-8")))
    issued_at = int(payload.get("iat", 0))
    if issued_at <= 0 or time.time() - issued_at > TOKEN_TTL_SECONDS:
        raise RuntimeError("Token expired")
    username = str(payload.get("sub", ""))
    if username != AUTH_USERNAME:
        raise RuntimeError("Invalid token")
    return username


def summarize_with_deepseek(transcript: str) -> str:
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not configured")

    prompt = f"""
请基于下面的视频逐字稿生成结构化中文 summary。
要求：
1. 先给 5-10 条要点。
2. 再按主题分段总结。
3. 最后列出可能的行动项、待确认问题和关键词。
4. 不要编造逐字稿中没有的信息。

逐字稿：
{transcript[:60000]}
""".strip()

    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": [
            {"role": "system", "content": "你是一个严谨的课程/会议视频总结助手。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(
        DEEPSEEK_API_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urlopen(request, timeout=90) as response:
        data = json.loads(response.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"].strip()


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_POST(self) -> None:
        try:
            auth = self.headers.get("authorization", "")
            if not auth.startswith("Bearer "):
                self.send_json({"detail": "Missing bearer token"}, 401)
                return
            verify_token(auth.removeprefix("Bearer ").strip())

            data = self.read_json()
            transcript = str(data.get("transcript", "")).strip()
            if not transcript:
                self.send_json({"detail": "transcript is required"}, 400)
                return
            summary = summarize_with_deepseek(transcript)
            self.send_json({"summary": summary})
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
