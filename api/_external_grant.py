from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


_TRUE_VALUES = {"1", "true", "yes", "on"}
_PLAN_CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9-]{1,31}$")
_METADATA_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")


@dataclass(frozen=True)
class ExternalGrantConfig:
    grant_url: str
    plan_codes: frozenset[str]
    benefit_site: str
    benefit_plan_by_code: dict[str, str]
    gift_benefit_site: str
    metadata_key: str
    user_agent: str

    def benefit_plan_for(self, plan_code: str) -> str | None:
        return self.benefit_plan_by_code.get(_normalize_plan_code(plan_code))


def external_link_enabled() -> bool:
    return (os.getenv("VID2PPT_EXTERNAL_LINK_ENABLED") or "").strip().lower() in _TRUE_VALUES


def load_external_grant_config() -> ExternalGrantConfig | None:
    encoded = (os.getenv("VID2PPT_EXTERNAL_GRANT_CONFIG_B64") or "").strip()
    if not encoded:
        return None
    try:
        padded = encoded + "=" * ((4 - len(encoded) % 4) % 4)
        raw = base64.b64decode(padded, validate=True)
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None

    if not isinstance(payload, dict) or payload.get("version") != 1:
        return None

    grant_url = _clean_text(payload.get("grant_url"), 500)
    try:
        parsed_url = urllib.parse.urlparse(grant_url)
    except ValueError:
        return None
    if parsed_url.scheme != "https" or not parsed_url.netloc:
        return None

    raw_plan_codes = payload.get("plan_codes")
    raw_plan_map = payload.get("benefit_plan_by_code")
    if not isinstance(raw_plan_codes, list) or not isinstance(raw_plan_map, dict):
        return None

    plan_codes = frozenset(_normalize_plan_code(item) for item in raw_plan_codes)
    if not plan_codes or "" in plan_codes or any(not _PLAN_CODE_RE.fullmatch(item) for item in plan_codes):
        return None

    benefit_plan_by_code: dict[str, str] = {}
    for plan_code in plan_codes:
        benefit_plan = _clean_text(raw_plan_map.get(plan_code), 120)
        if not benefit_plan:
            return None
        benefit_plan_by_code[plan_code] = benefit_plan

    benefit_site = _clean_text(payload.get("benefit_site"), 120)
    gift_benefit_site = _clean_text(payload.get("gift_benefit_site"), 255)
    metadata_key = _clean_text(payload.get("metadata_key"), 64)
    user_agent = _clean_text(payload.get("user_agent"), 300)
    if not benefit_site or not gift_benefit_site or not user_agent:
        return None
    if not _METADATA_KEY_RE.fullmatch(metadata_key):
        return None

    return ExternalGrantConfig(
        grant_url=grant_url,
        plan_codes=plan_codes,
        benefit_site=benefit_site,
        benefit_plan_by_code=benefit_plan_by_code,
        gift_benefit_site=gift_benefit_site,
        metadata_key=metadata_key,
        user_agent=user_agent,
    )


def resolve_external_benefit(plan_code: str) -> tuple[ExternalGrantConfig | None, str | None]:
    if not external_link_enabled():
        return None, None
    config = load_external_grant_config()
    if config is None:
        return None, None
    normalized_plan_code = _normalize_plan_code(plan_code)
    benefit_plan = config.benefit_plan_for(normalized_plan_code)
    if not benefit_plan:
        return None, None
    return config, benefit_plan


def grant_external_benefit(
    *,
    config: ExternalGrantConfig,
    email: str,
    plan_code: str,
    request_id: str,
    transaction_id: str,
    event_id: str,
    completed_at: str,
    amount_cny: str,
    quantity: int,
) -> dict[str, Any]:
    if not external_link_enabled():
        return {"attempted": False, "ok": False, "reason": "feature_disabled"}

    normalized_plan_code = _normalize_plan_code(plan_code)
    if not email or not config.benefit_plan_for(normalized_plan_code):
        return {"attempted": False, "ok": False, "reason": "unsupported_plan_or_missing_email"}

    secret = (os.getenv("VID2PPT_EXTERNAL_GRANT_SECRET") or "").strip()
    if not secret:
        return {"attempted": False, "ok": False, "reason": "missing_secret"}

    payload = {
        "email": email,
        "plan_code": normalized_plan_code,
        "request_id": request_id,
        "paddle_transaction_id": transaction_id,
        "event_id": event_id,
        "completed_at": completed_at,
        "amount_cny": amount_cny,
        "quantity": quantity,
        "legal_purchase_site": "vid2ppt.com",
        "gift_benefit_site": config.gift_benefit_site,
    }
    raw_body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(
        config.grant_url,
        data=raw_body,
        method="POST",
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": config.user_agent,
            "X-Vid2PPT-Signature": f"sha256={signature}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            body = response.read().decode("utf-8", errors="replace")
            data = json.loads(body) if body else {}
            return {
                "attempted": True,
                "ok": 200 <= response.status < 300 and bool(data.get("ok", True)),
                "status": response.status,
                "response": data,
            }
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return {"attempted": True, "ok": False, "status": exc.code, "response": body[:500]}
    except Exception as exc:
        return {"attempted": True, "ok": False, "status": 0, "response": str(exc)[:500]}


def _normalize_plan_code(value: Any) -> str:
    return str(value or "").strip().upper()


def _clean_text(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""
