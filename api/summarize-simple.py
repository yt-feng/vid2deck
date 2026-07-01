from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler
from typing import Any
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.request import Request, urlopen

try:
    from _auth import verify_user_token
    from _plans import effective_plan, plan_limits
    from _supabase import find_entitlement, insert_usage_event, list_usage_events
except ModuleNotFoundError:
    from api._auth import verify_user_token
    from api._plans import effective_plan, plan_limits
    from api._supabase import find_entitlement, insert_usage_event, list_usage_events

AUTH_CODE = (os.getenv("AUTH_CODE") or "").strip()
DEEPSEEK_API_URL = os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com/chat/completions")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
ACTIVE_STATUSES = {"active", "trialing"}
SUMMARY_EVENT_TYPE = "summary_generation"


class SummaryQuotaError(RuntimeError):
    pass


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
            user = authorized_user(self.headers.get("x-access-code", ""), self.headers.get("authorization", ""))
            if user is None:
                self.send_json({"detail": "请先登录账号。"}, 401)
                return

            data = self.read_json()
            transcript = str(data.get("transcript", "")).strip()
            if not transcript:
                self.send_json({"detail": "transcript is required"}, 400)
                return

            email = str(user.get("email") or "").strip().lower()
            if email:
                ensure_summary_quota(email)

            summary = make_summary(transcript)
            usage = None
            if email:
                insert_usage_event(email, SUMMARY_EVENT_TYPE, {"source": "summary_api"}, units=1)
                usage = usage_payload(email)
            payload: dict[str, Any] = {"summary": summary}
            if usage:
                payload["usage"] = usage
            self.send_json(payload)
        except SummaryQuotaError as exc:
            self.send_json({"detail": str(exc)}, 402)
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


def authorized_user(access_code_header: str, authorization_header: str) -> dict[str, Any] | None:
    access_code = access_code_header.strip()
    if AUTH_CODE and access_code == AUTH_CODE:
        return {"username": "access-code", "email": ""}

    prefix = "Bearer "
    if not authorization_header.startswith(prefix):
        return None
    token = authorization_header.removeprefix(prefix).strip()
    try:
        return verify_user_token(token)
    except Exception:
        return None


def ensure_summary_quota(email: str) -> None:
    limits = plan_limits(effective_plan_for_email(email))
    limit = limits.get("summary_generations_monthly")
    if limit is None:
        return
    used = usage_payload(email)["monthly"].get(SUMMARY_EVENT_TYPE, 0)
    if int(used) + 1 > int(limit):
        raise SummaryQuotaError(f"免费 Summary 次数已用完：本月 {used}/{limit} 次。请在定价页开通或升级后继续。")


def effective_plan_for_email(email: str) -> str:
    row = find_entitlement(email)
    if not row:
        return "free"
    plan = str(row.get("plan") or "free")
    status = str(row.get("status") or "inactive")
    lifetime = bool(row.get("lifetime"))
    active = status in ACTIVE_STATUSES and (lifetime or period_is_current(row.get("current_period_end")))
    return effective_plan(plan, active)


def usage_payload(email: str) -> dict[str, Any]:
    period_start = month_start_iso()
    monthly: dict[str, int] = {
        "video_conversion": 0,
        "editable_slide": 0,
        SUMMARY_EVENT_TYPE: 0,
        "transcribe_minute": 0,
    }
    for event in list_usage_events(email, period_start):
        event_type = str(event.get("event_type") or "")
        if event_type not in monthly:
            continue
        monthly[event_type] += max(0, int(event.get("units") or 0))
    return {
        "email": email,
        "period": "monthly",
        "period_start": period_start,
        "monthly": monthly,
    }


def month_start_iso() -> str:
    now = datetime.now(timezone.utc)
    return datetime(now.year, now.month, 1, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def period_is_current(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed > datetime.now(timezone.utc)
