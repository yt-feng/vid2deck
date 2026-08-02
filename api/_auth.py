from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import os
import random
import re
import secrets
import time
from typing import Any


TOKEN_TTL_SECONDS = int(os.getenv("TOKEN_TTL_SECONDS", str(30 * 24 * 60 * 60)))
CAPTCHA_TTL_SECONDS = int(os.getenv("CAPTCHA_TTL_SECONDS", "600"))
PASSWORD_ITERATIONS = int(os.getenv("PASSWORD_ITERATIONS", "120000"))
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{2,31}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
GENERATED_EMAIL_DOMAIN = os.getenv("GENERATED_EMAIL_DOMAIN", "users.vid2ppt.com")


def signing_secret() -> bytes:
    secret = os.getenv("AUTH_SECRET") or os.getenv("AUTH_CODE") or os.getenv("DEEPSEEK_API_KEY", "")
    if not secret:
        raise RuntimeError("AUTH_SECRET, AUTH_CODE, or DEEPSEEK_API_KEY is not configured")
    return secret.strip().encode("utf-8")


def normalize_username(value: str) -> str:
    return value.strip().lower().removeprefix("@")


def valid_username(username: str) -> bool:
    return bool(USERNAME_RE.match(username))


def normalize_email(value: str) -> str:
    email = value.strip().lower()
    if not email:
        return ""
    return email if EMAIL_RE.match(email) else ""


def generated_email_for_username(username: str) -> str:
    return f"{username}@{GENERATED_EMAIL_DOMAIN}"


def is_generated_email(email: str) -> bool:
    return email.strip().lower().endswith(f"@{GENERATED_EMAIL_DOMAIN}")


def hash_password(password: str) -> tuple[str, str]:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), PASSWORD_ITERATIONS)
    digest_b64 = base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")
    return salt, f"pbkdf2_sha256${PASSWORD_ITERATIONS}${digest_b64}"


def verify_password(password: str, salt: str, stored_hash: str) -> bool:
    try:
        algorithm, iterations_text, digest_b64 = stored_hash.split("$", 2)
        iterations = int(iterations_text)
    except ValueError:
        algorithm = "pbkdf2_sha256"
        iterations = PASSWORD_ITERATIONS
        digest_b64 = stored_hash

    if algorithm != "pbkdf2_sha256":
        return False

    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), iterations)
    expected = base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")
    return hmac.compare_digest(expected, digest_b64)


def create_user_token(user: dict[str, Any]) -> str:
    return sign_payload(
        {
            "kind": "user",
            "sub": str(user.get("id") or ""),
            "username": str(user.get("username") or ""),
            "email": str(user.get("email") or ""),
            "iat": int(time.time()),
        }
    )


def verify_user_token(token: str) -> dict[str, Any]:
    payload = verify_signed_payload(token, TOKEN_TTL_SECONDS)
    if payload.get("kind") != "user":
        raise RuntimeError("Invalid token")
    if not payload.get("username"):
        raise RuntimeError("Invalid token")
    return payload


def sign_payload(payload: dict[str, Any]) -> str:
    payload_bytes = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload_b64 = base64.urlsafe_b64encode(payload_bytes).decode("utf-8").rstrip("=")
    signature = hmac.new(signing_secret(), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{signature}"


def verify_signed_payload(token: str, max_age_seconds: int) -> dict[str, Any]:
    try:
        payload_b64, signature = token.split(".", 1)
    except ValueError as exc:
        raise RuntimeError("Invalid token") from exc

    expected = hmac.new(signing_secret(), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise RuntimeError("Invalid token")

    padded = payload_b64 + "=" * (-len(payload_b64) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded.encode("utf-8")).decode("utf-8"))
    issued_at = int(payload.get("iat", 0))
    if issued_at <= 0 or time.time() - issued_at > max_age_seconds:
        raise RuntimeError("Token expired")
    return payload


def create_captcha_challenge() -> dict[str, str | int]:
    left = random.randint(2, 9)
    right = random.randint(1, 9)
    answer = str(left + right)
    nonce = secrets.token_urlsafe(12)
    payload = {
        "kind": "captcha",
        "iat": int(time.time()),
        "nonce": nonce,
        "answer_hash": captcha_answer_hash(answer, nonce),
    }
    question = f"{left} + {right} = ?"
    svg = captcha_svg(question)
    image = "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("utf-8")
    return {"token": sign_payload(payload), "image": image, "expires_in": CAPTCHA_TTL_SECONDS}


def verify_captcha_response(token: str, answer: str) -> bool:
    try:
        payload = verify_signed_payload(token, CAPTCHA_TTL_SECONDS)
    except Exception:
        return False
    if payload.get("kind") != "captcha":
        return False
    nonce = str(payload.get("nonce") or "")
    stored_hash = str(payload.get("answer_hash") or "")
    clean_answer = re.sub(r"\D+", "", answer or "")
    if not nonce or not stored_hash or not clean_answer:
        return False
    return hmac.compare_digest(stored_hash, captcha_answer_hash(clean_answer, nonce))


def captcha_answer_hash(answer: str, nonce: str) -> str:
    message = f"captcha:{nonce}:{answer}".encode("utf-8")
    return hmac.new(signing_secret(), message, hashlib.sha256).hexdigest()


def captcha_svg(question: str) -> str:
    escaped = html.escape(question)
    line_a = random.randint(12, 28)
    line_b = random.randint(84, 108)
    dot_a = random.randint(24, 132)
    dot_b = random.randint(18, 50)
    rotate = random.randint(-5, 5)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="180" height="64" viewBox="0 0 180 64" role="img" aria-label="captcha">
  <rect width="180" height="64" rx="14" fill="#f8fafc"/>
  <path d="M8 {line_a} C52 2, 92 68, 172 {line_b}" fill="none" stroke="#93c5fd" stroke-width="3" opacity=".75"/>
  <path d="M4 {line_b} C48 70, 118 -4, 176 {line_a}" fill="none" stroke="#bbf7d0" stroke-width="3" opacity=".75"/>
  <circle cx="{dot_a}" cy="{dot_b}" r="4" fill="#c4b5fd" opacity=".8"/>
  <text x="90" y="42" text-anchor="middle" transform="rotate({rotate} 90 32)" fill="#0f172a" font-size="28" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-weight="900">{escaped}</text>
</svg>"""


def public_user(row: dict[str, Any]) -> dict[str, Any]:
    email = str(row.get("email") or "")
    return {
        "id": row.get("id"),
        "username": row.get("username"),
        "email": email,
        "email_is_generated": bool(row.get("email_is_generated")) or is_generated_email(email),
        "site_origin": row.get("site_origin") or "vid2ppt",
        "registered_site": row.get("registered_site") or row.get("site_origin") or "vid2ppt",
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }
