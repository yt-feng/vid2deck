from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler
from typing import Any

try:
    from _auth import (
        create_user_token,
        generated_email_for_username,
        hash_password,
        normalize_email,
        normalize_username,
        public_user,
        valid_username,
        verify_captcha_response,
        verify_password,
        verify_user_token,
    )
    from _supabase import SupabaseError, create_site_user, find_site_user_by_username, update_site_user, utc_now_iso
except ModuleNotFoundError:
    from api._auth import (
        create_user_token,
        generated_email_for_username,
        hash_password,
        normalize_email,
        normalize_username,
        public_user,
        valid_username,
        verify_captcha_response,
        verify_password,
        verify_user_token,
    )
    from api._supabase import SupabaseError, create_site_user, find_site_user_by_username, update_site_user, utc_now_iso


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        try:
            token = bearer_token(self.headers.get("authorization", ""))
            if not token:
                self.send_json({"ok": True, "route": "/api/auth", "method": "POST login/register"})
                return
            payload = verify_user_token(token)
            username = normalize_username(str(payload.get("username") or ""))
            user = find_site_user_by_username(username)
            if not user:
                self.send_json({"detail": "账号不存在或已被移除。"}, 401)
                return
            self.send_session(user)
        except Exception as exc:
            self.send_json({"detail": str(exc)}, 401)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_POST(self) -> None:
        try:
            data = self.read_json()
            action = str(data.get("action") or "login").strip().lower()
            if action not in {"login", "register"}:
                self.send_json({"detail": "Unsupported auth action"}, 400)
                return

            if not verify_captcha_response(str(data.get("captcha_token") or ""), str(data.get("captcha_answer") or "")):
                self.send_json({"detail": "验证码不正确或已过期。"}, 400)
                return

            username = normalize_username(str(data.get("username") or ""))
            password = str(data.get("password") or "")
            if not valid_username(username):
                self.send_json({"detail": "用户名需为 3-32 位小写字母、数字、点、短横线或下划线。"}, 400)
                return
            if len(password) < 4 or len(password) > 128:
                self.send_json({"detail": "密码需为 4-128 位。"}, 400)
                return

            if action == "register":
                self.register(username, password, str(data.get("email") or ""))
            else:
                self.login(username, password)
        except SupabaseError as exc:
            detail = "数据库写入失败。"
            if exc.status == 409:
                detail = "用户名或邮箱已被注册。"
            elif "site_users" in exc.body:
                detail = "Supabase 缺少 site_users 表，请先执行项目里的 supabase/schema.sql。"
            self.send_json({"detail": detail}, 500 if exc.status != 409 else 409)
        except Exception as exc:
            self.send_json({"detail": str(exc)}, 500)

    def register(self, username: str, password: str, raw_email: str) -> None:
        existing = find_site_user_by_username(username)
        if existing:
            self.send_json({"detail": "用户名已被注册。"}, 409)
            return

        email = normalize_email(raw_email)
        email_is_generated = False
        if raw_email.strip() and not email:
            self.send_json({"detail": "邮箱格式不正确，可以留空。"}, 400)
            return
        if not email:
            email = generated_email_for_username(username)
            email_is_generated = True

        salt, password_hash = hash_password(password)
        now = utc_now_iso()
        user = create_site_user(
            {
                "username": username,
                "email": email,
                "email_is_generated": email_is_generated,
                "password_salt": salt,
                "password_hash": password_hash,
                "created_at": now,
                "updated_at": now,
                "last_login_at": now,
            }
        )
        self.send_session(user, status=201)

    def login(self, username: str, password: str) -> None:
        user = find_site_user_by_username(username)
        if not user or not verify_password(password, str(user.get("password_salt") or ""), str(user.get("password_hash") or "")):
            self.send_json({"detail": "用户名或密码不正确。"}, 401)
            return
        updated = update_site_user(str(user.get("id")), {"last_login_at": utc_now_iso()}) if user.get("id") else user
        self.send_session({**user, **updated})

    def send_session(self, user: dict[str, Any], status: int = 200) -> None:
        self.send_json({"token": create_user_token(user), "user": public_user(user)}, status)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0") or "0")
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        return json.loads(body or "{}")

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


def bearer_token(header: str) -> str:
    prefix = "Bearer "
    if not header.startswith(prefix):
        return ""
    return header.removeprefix(prefix).strip()
