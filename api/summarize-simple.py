from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

try:
    from _auth import verify_user_token
except ModuleNotFoundError:
    from api._auth import verify_user_token

AUTH_CODE = (os.getenv("AUTH_CODE") or "").strip()
DEEPSEEK_API_URL = os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com/chat/completions")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")


def make_summary(transcript: str) -> str:
    api_key = (os.getenv("DEEPSEEK_API_KEY") or "").strip()
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
    try:
        with urlopen(request, timeout=90) as response:
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(f"DeepSeek HTTP {exc.code}: {detail}") from exc
    return data["choices"][0]["message"]["content"].strip()


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_json({"ok": True, "route": "/api/summarize-simple", "method": "POST only"})

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_POST(self) -> None:
        try:
            if not request_is_authorized(self.headers.get("x-access-code", ""), self.headers.get("authorization", "")):
                self.send_json({"detail": "请先登录账号。"}, 401)
                return

            data = self.read_json()
            transcript = str(data.get("transcript", "")).strip()
            if not transcript:
                self.send_json({"detail": "transcript is required"}, 400)
                return

            self.send_json({"summary": make_summary(transcript)})
        except Exception as exc:
            self.send_json({"detail": str(exc)}, 500)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0") or "0")
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        return json.loads(body or "{}")

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", os.getenv("CORS_ORIGINS", "*"))
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Access-Code")

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def request_is_authorized(access_code_header: str, authorization_header: str) -> bool:
    access_code = access_code_header.strip()
    if AUTH_CODE and access_code == AUTH_CODE:
        return True

    prefix = "Bearer "
    if not authorization_header.startswith(prefix):
        return False
    token = authorization_header.removeprefix(prefix).strip()
    try:
        verify_user_token(token)
        return True
    except Exception:
        return False
