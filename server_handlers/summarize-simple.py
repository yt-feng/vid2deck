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
    from _plans import effective_plan, is_owner_identity, plan_limits
    from _supabase import find_entitlement, insert_usage_event, list_usage_events
except ModuleNotFoundError:
    from api._auth import verify_user_token
    from api._plans import effective_plan, is_owner_identity, plan_limits
    from api._supabase import find_entitlement, insert_usage_event, list_usage_events

AUTH_CODE = (os.getenv("AUTH_CODE") or "").strip()
DEEPSEEK_API_URL = os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com/chat/completions")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
ACTIVE_STATUSES = {"active", "trialing"}
SUMMARY_EVENT_TYPE = "summary_generation"
LANGUAGE_LABELS = {
    "zh-CN": "简体中文",
    "zh-TW": "繁体中文",
    "en": "English",
    "ja": "日本語",
    "ko": "한국어",
}


class SummaryQuotaError(RuntimeError):
    pass


def make_summary(transcript: str, output_language: str = "zh-CN", mode: str = "summary", source_title: str = "") -> str:
    api_key = (os.getenv("DEEPSEEK_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not configured")

    language = LANGUAGE_LABELS.get(output_language, LANGUAGE_LABELS["zh-CN"])
    if mode == "illustrated_notes":
        task = f"""
请把下面的视频逐字稿整理成一篇可直接发布的图文笔记，输出语言为{language}。
要求：
1. 只输出 Markdown 正文，第一行使用一级标题；标题需具体，不要写“视频总结”。
2. 先写 3-5 句导读，再组织 5-8 个二级标题章节，每节包含清晰观点、解释和必要的列表。
3. 最后给出“核心结论”和“关键词”。
4. 不要插入图片链接或图片占位符，系统会自动穿插视频关键页面。
5. 不要编造逐字稿中没有的信息；信息不确定时明确说明。
6. 来源标题仅供理解语境：{source_title[:300] or '未提供'}。
""".strip()
    else:
        task = f"""
请基于下面的视频逐字稿生成结构化摘要，输出语言为{language}。
要求：
1. 先给 5-10 条要点。
2. 再按主题分段总结。
3. 最后列出可能的行动项、待确认问题和关键词。
4. 不要编造逐字稿中没有的信息。
""".strip()

    prompt = f"""
{task}

逐字稿：
{transcript[:60000]}
""".strip()

    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": [
            {"role": "system", "content": "你是一个严谨、擅长知识整理和编辑成稿的视频笔记助手。"},
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
            username = str(user.get("username") or "").strip().lower()
            output_language = str(data.get("language") or "zh-CN")
            if output_language not in LANGUAGE_LABELS:
                output_language = "zh-CN"
            mode = "illustrated_notes" if data.get("mode") == "illustrated_notes" else "summary"
            source_title = str(data.get("source_title") or "").strip()
            if email:
                ensure_summary_quota(email, username)

            summary = make_summary(transcript, output_language, mode, source_title)
            usage = None
            if email:
                insert_usage_event(
                    email,
                    SUMMARY_EVENT_TYPE,
                    {"source": "summary_api", "mode": mode, "language": output_language},
                    units=1,
                )
                usage = usage_payload(email)
            payload: dict[str, Any] = {"summary": summary, "mode": mode, "language": output_language}
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


def ensure_summary_quota(email: str, username: str = "") -> None:
    limits = plan_limits(effective_plan_for_email(email, username))
    limit = limits.get("summary_generations_monthly")
    if limit is None:
        return
    used = usage_payload(email)["monthly"].get(SUMMARY_EVENT_TYPE, 0)
    if int(used) + 1 > int(limit):
        raise SummaryQuotaError(f"免费摘要与笔记次数已用完：本月 {used}/{limit} 次。请在定价页开通或升级后继续。")


def effective_plan_for_email(email: str, username: str = "") -> str:
    if is_owner_identity(email, username):
        return "lifetime"
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
