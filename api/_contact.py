from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import uuid
from typing import Any, BinaryIO, Mapping
from urllib.parse import urlsplit

import httpx


MAX_BODY_BYTES = 32 * 1024
BREVO_EMAIL_URL = "https://api.brevo.com/v3/smtp/email"
TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
DEFAULT_ORIGINS = frozenset({"https://vid2ppt.com", "https://www.vid2ppt.com"})
HEADER_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
EMAIL_LOCAL_RE = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$")
DOMAIN_LABEL_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")


class ContactError(Exception):
    def __init__(self, detail: str, status: int = 400) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status = status


def allowed_origins() -> frozenset[str]:
    extra = {
        value.strip().rstrip("/")
        for value in os.getenv("CONTACT_ALLOWED_ORIGINS", "").split(",")
        if value.strip()
    }
    # Do not let a wildcard turn the public form into an arbitrary-site relay.
    return DEFAULT_ORIGINS | frozenset(value for value in extra if valid_origin(value))


def valid_origin(value: str) -> bool:
    try:
        parsed = urlsplit(value)
        return bool(
            parsed.scheme in {"http", "https"}
            and parsed.netloc
            and parsed.hostname
            and not parsed.username
            and not parsed.password
            and not parsed.path
            and not parsed.query
            and not parsed.fragment
            and not HEADER_CONTROL_RE.search(value)
        )
    except ValueError:
        return False


def validate_origin(headers: Mapping[str, str]) -> None:
    origin = headers.get("origin", "")
    if origin and origin not in allowed_origins():
        raise ContactError("请在 vid2ppt.com 的联系页面提交留言。", 403)
    if not origin and headers.get("sec-fetch-site", "").lower() == "cross-site":
        raise ContactError("请在 vid2ppt.com 的联系页面提交留言。", 403)


def read_contact_json(headers: Mapping[str, str], stream: BinaryIO) -> dict[str, Any]:
    if headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise ContactError("提交格式不正确，请通过网站联系表单发送留言。", 415)
    if headers.get("transfer-encoding"):
        raise ContactError("无法识别本次提交格式，请刷新页面后重试。", 400)
    try:
        length = int(headers.get("content-length", "0"))
    except (ValueError, TypeError):
        raise ContactError("本次提交的数据不完整，请重试。") from None
    if length <= 0:
        raise ContactError("请填写联系表单后再提交。")
    if length > MAX_BODY_BYTES:
        raise ContactError("提交内容过长，请精简后重试。", 413)
    body = stream.read(length)
    if len(body) != length:
        raise ContactError("留言内容未完整传送，请重试。")
    try:
        data = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ContactError("无法读取本次留言，请重试。") from None
    if not isinstance(data, dict):
        raise ContactError("请填写联系表单后再提交。")
    return data


def text_field(data: dict[str, Any], key: str, maximum: int, *, minimum: int = 1) -> str:
    value = data.get(key, "")
    label = {"name": "称呼", "email": "邮箱地址", "subject": "留言主题", "message": "留言内容"}.get(key, "内容")
    if not isinstance(value, str):
        raise ContactError(f"请填写有效的{label}。")
    # Header fields must not accept CR/LF, even around an otherwise valid value.
    if key != "message" and HEADER_CONTROL_RE.search(value):
        raise ContactError(f"请填写有效的{label}。")
    if key == "message" and re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
        raise ContactError("留言中包含无法识别的字符，请删除后重试。")
    value = value.strip()
    if len(value) < minimum:
        raise ContactError(f"请填写{label}。" if minimum == 1 else f"{label}至少需要 {minimum} 个字符，请补充后提交。")
    if len(value) > maximum:
        raise ContactError(f"{label}请控制在 {maximum} 个字符以内。")
    return value


def normalize_email(value: str) -> str:
    if len(value) > 254 or HEADER_CONTROL_RE.search(value) or value.count("@") != 1:
        return ""
    local, domain = value.rsplit("@", 1)
    if not local or len(local) > 64 or not EMAIL_LOCAL_RE.fullmatch(local):
        return ""
    if local.startswith(".") or local.endswith(".") or ".." in local:
        return ""
    try:
        domain = domain.encode("idna").decode("ascii").lower()
    except UnicodeError:
        return ""
    labels = domain.split(".")
    if len(labels) < 2 or len(domain) > 253 or not all(DOMAIN_LABEL_RE.fullmatch(label) for label in labels):
        return ""
    return f"{local}@{domain}"


def validate_contact(data: dict[str, Any]) -> dict[str, str]:
    website = data.get("website", "")
    if not isinstance(website, str) or website.strip():
        raise ContactError("本次留言未能提交，请直接发送邮件至 info@vid2ppt.com。")
    contact = {
        "name": text_field(data, "name", 100, minimum=0),
        "email": text_field(data, "email", 254),
        "subject": text_field(data, "subject", 160),
        "message": text_field(data, "message", 5000, minimum=10),
    }
    contact["email"] = normalize_email(contact["email"])
    if not contact["email"]:
        raise ContactError("请填写有效的邮箱地址，方便我们回复。")
    request_id = data.get("request_id", "")
    if request_id:
        try:
            contact["request_id"] = str(uuid.UUID(request_id)) if isinstance(request_id, str) else ""
        except ValueError:
            raise ContactError("本次提交标识已失效，请刷新页面后重试。") from None
        if not contact["request_id"]:
            raise ContactError("本次提交标识已失效，请刷新页面后重试。")
    else:
        contact["request_id"] = str(uuid.uuid4())
    return contact


def verify_turnstile(data: dict[str, Any]) -> None:
    token = data.get("turnstile_token")
    if not isinstance(token, str) or not 1 <= len(token) <= 2048 or HEADER_CONTROL_RE.search(token):
        raise ContactError("请先完成验证，再提交留言。", 400)
    secret = os.getenv("CONTACT_TURNSTILE_SECRET_KEY", "").strip()
    if not secret:
        raise ContactError("联系表单暂时无法使用，请直接发送邮件至 info@vid2ppt.com。", 503)
    try:
        response = httpx.post(
            TURNSTILE_VERIFY_URL,
            # Keep the token single-use. Reusing a client-provided Siteverify
            # idempotency key would permit repeated sends without durable storage.
            json={"secret": secret, "response": token},
            timeout=httpx.Timeout(10.0, connect=5.0),
        )
    except httpx.RequestError:
        raise ContactError("验证服务暂时无法连接，请稍后重试。", 503) from None
    try:
        result = response.json()
    except ValueError:
        result = {}
    if not 200 <= response.status_code < 300 or not isinstance(result, dict):
        raise ContactError("验证服务暂时无法连接，请稍后重试。", 503)
    if result.get("success") is not True:
        raise ContactError("验证已过期或未通过，请重新验证后提交。", 400)
    if result.get("hostname") not in {"vid2ppt.com", "www.vid2ppt.com"} or result.get("action") != "contact":
        raise ContactError("验证与当前页面不匹配，请重新验证后提交。", 403)


def send_contact_message(contact: dict[str, str]) -> dict[str, Any]:
    provider = os.getenv("CONTACT_EMAIL_PROVIDER", "cloudflare").strip().lower()
    if provider not in {"cloudflare", "brevo"}:
        raise ContactError("联系表单暂时无法使用，请直接发送邮件至 info@vid2ppt.com。", 503)
    secret_name = "CLOUDFLARE_EMAIL_API_TOKEN" if provider == "cloudflare" else "BREVO_API_KEY"
    api_key = os.getenv(secret_name, "").strip()
    from_email = normalize_email(os.getenv("CONTACT_FROM_EMAIL", "").strip())
    to_email = normalize_email(os.getenv("CONTACT_TO_EMAIL", "").strip())
    if not api_key or not from_email or not to_email:
        raise ContactError("联系表单暂时无法使用，请直接发送邮件至 info@vid2ppt.com。", 503)

    # Include the content and fixed destination so a reused client ID cannot
    # suppress a different message. No recipient or API key is exposed publicly.
    fingerprint = json.dumps({**contact, "to": to_email}, sort_keys=True, ensure_ascii=False).encode("utf-8")
    digest = hmac.new(api_key.encode("utf-8"), fingerprint, hashlib.sha256).digest()
    idempotency_key = str(uuid.UUID(bytes=digest[:16], version=4))
    reference = "V2P-" + idempotency_key.replace("-", "")[:20].upper()
    subject = f"[Vid2PPT {reference}] {contact['subject']}"
    text = "\n".join([
        "New message from the Vid2PPT contact form",
        "",
        f"Reference: {reference}",
        f"Name: {contact['name'] or '(not provided)'}",
        f"Email: {contact['email']}",
        f"Subject: {contact['subject']}",
        "",
        contact["message"],
        "",
        "Reply to this email to contact the sender directly.",
    ])
    if provider == "cloudflare":
        return send_cloudflare_email(contact, api_key, from_email, to_email, subject, text, reference)
    payload = {
        "sender": {"name": "Vid2PPT Contact", "email": from_email},
        "to": [{"email": to_email}],
        "replyTo": {"email": contact["email"], **({"name": contact["name"]} if contact["name"] else {})},
        "subject": subject,
        "textContent": text,
        "headers": {"X-Contact-Reference": reference, "idempotencyKey": idempotency_key},
        "tags": ["vid2ppt-contact"],
    }
    try:
        response = httpx.post(
            BREVO_EMAIL_URL,
            headers={"api-key": api_key, "accept": "application/json", "idempotencyKey": idempotency_key},
            json=payload,
            timeout=httpx.Timeout(15.0, connect=5.0),
        )
    except httpx.RequestError:
        raise ContactError("暂时无法确认留言是否已发送，请稍后重试，或直接发送邮件至 info@vid2ppt.com。", 502) from None
    try:
        result = response.json()
    except ValueError:
        result = {}
    if not isinstance(result, dict):
        result = {}
    # Brevo rejects a repeated accepted key for 30 minutes. The original send's
    # log and email contain the same reference; a retry must not send it again.
    if response.status_code == 400 and result.get("code") == "duplicate_parameter":
        audit_event("contact.duplicate", reference)
        return {"success": True, "reference": reference}
    message_id = result.get("messageId")
    if 200 <= response.status_code < 300 and isinstance(message_id, str) and message_id.strip():
        audit_event("contact.accepted", reference, provider_message_id=message_id)
        return {"success": True, "reference": reference}
    audit_event("contact.provider_rejected", reference, provider_status=response.status_code)
    status = 503 if response.status_code in {401, 402, 403, 429} else 502
    raise ContactError("留言暂时未能发送，请稍后重试，或直接发送邮件至 info@vid2ppt.com。", status)


def send_cloudflare_email(
    contact: dict[str, str], api_token: str, from_email: str, to_email: str,
    subject: str, text: str, reference: str,
) -> dict[str, Any]:
    account_id = os.getenv("CLOUDFLARE_ACCOUNT_ID", "").strip()
    if not re.fullmatch(r"[A-Fa-f0-9]{32}", account_id):
        raise ContactError("联系表单暂时无法使用，请直接发送邮件至 info@vid2ppt.com。", 503)
    try:
        response = httpx.post(
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send",
            headers={"Authorization": f"Bearer {api_token}", "accept": "application/json"},
            json={
                "from": {"address": from_email, "name": "Vid2PPT Contact"},
                "to": to_email,
                "reply_to": {"address": contact["email"], **({"name": contact["name"]} if contact["name"] else {})},
                "subject": subject,
                "text": text,
                "headers": {"X-Contact-Reference": reference},
            },
            timeout=httpx.Timeout(20.0, connect=5.0),
        )
    except httpx.RequestError:
        raise ContactError("暂时无法确认留言是否已发送，请稍后重试，或直接发送邮件至 info@vid2ppt.com。", 502) from None
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    result = payload.get("result")
    if not isinstance(result, dict):
        result = {}

    def contains_recipient(key: str) -> bool:
        addresses = result.get(key, [])
        return isinstance(addresses, list) and any(
            isinstance(address, str) and address.strip().lower() == to_email.lower()
            for address in addresses
        )

    accepted = contains_recipient("delivered") or contains_recipient("queued")
    rejected = contains_recipient("permanent_bounces") or contains_recipient("suppressed_recipients")
    if 200 <= response.status_code < 300 and payload.get("success") is True and not payload.get("errors") and accepted and not rejected:
        fields: dict[str, Any] = {
            "provider": "cloudflare",
            "delivery_status": "delivered" if contains_recipient("delivered") else "queued",
        }
        message_id = result.get("message_id")
        if isinstance(message_id, str) and message_id.strip():
            fields["provider_message_id"] = message_id
        audit_event("contact.accepted", reference, **fields)
        return {"success": True, "reference": reference}

    audit_event("contact.provider_rejected", reference, provider="cloudflare", provider_status=response.status_code)
    status = 503 if response.status_code in {401, 402, 403, 429} else 502
    raise ContactError("留言暂时未能发送，请稍后重试，或直接发送邮件至 info@vid2ppt.com。", status)


def audit_event(event: str, reference: str, **fields: Any) -> None:
    # A reference joins the public receipt, email and provider ID without logging
    # the visitor's message, address, API key or private destination.
    print(json.dumps({"event": event, "reference": reference, **fields}), flush=True)


def send_contact_json(request: Any, payload: dict[str, Any], status: int = 200) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request.send_response(status)
    origin = request.headers.get("origin", "")
    if origin in allowed_origins():
        request.send_header("Access-Control-Allow-Origin", origin)
    request.send_header("Vary", "Origin")
    request.send_header("Cache-Control", "no-store")
    request.send_header("X-Content-Type-Options", "nosniff")
    request.send_header("Content-Type", "application/json; charset=utf-8")
    request.send_header("Content-Length", str(len(body)))
    request.end_headers()
    request.wfile.write(body)


def handle_contact_post(request: Any) -> None:
    """May also be called before body parsing by an existing API action router."""
    try:
        validate_origin(request.headers)
        data = read_contact_json(request.headers, request.rfile)
        contact = validate_contact(data)
        verify_turnstile(data)
        payload = send_contact_message(contact)
        send_contact_json(request, payload)
    except ContactError as exc:
        send_contact_json(request, {"detail": exc.detail}, exc.status)
    except Exception:
        # Never serialize upstream exception text into a public response.
        send_contact_json(request, {"detail": "留言未能发送，请重试，或直接发送邮件至 info@vid2ppt.com。"}, 500)


def handle_contact_options(request: Any) -> None:
    try:
        validate_origin(request.headers)
    except ContactError as exc:
        send_contact_json(request, {"detail": exc.detail}, exc.status)
        return
    request.send_response(204)
    origin = request.headers.get("origin", "")
    if origin in allowed_origins():
        request.send_header("Access-Control-Allow-Origin", origin)
    request.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
    request.send_header("Access-Control-Allow-Headers", "Content-Type")
    request.send_header("Vary", "Origin")
    request.send_header("Cache-Control", "no-store")
    request.end_headers()
