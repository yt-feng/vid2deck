from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any


SAFE_TABLE_RE = re.compile(r"^[a-z_][a-z0-9_]*$")
SITE_ORIGIN = os.getenv("SITE_ORIGIN", "vid2ppt")


class SupabaseError(RuntimeError):
    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self.body = body
        super().__init__(f"Supabase error {status}: {body[:500]}")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def supabase_base_url() -> str:
    url = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
    if not url:
        raise RuntimeError("SUPABASE_URL is not configured")
    return url


def supabase_service_key() -> str:
    key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not key:
        raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY is not configured")
    return key


def supabase_request(
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    *,
    prefer_return: bool = False,
) -> Any:
    key = supabase_service_key()
    url = f"{supabase_base_url()}{path}"
    data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}",
        "apikey": key,
    }
    if prefer_return:
        headers["Prefer"] = "return=representation"

    request = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(request, timeout=18) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SupabaseError(exc.code, body) from exc

    if not body:
        return None
    return json.loads(body)


def query_string(params: dict[str, str]) -> str:
    return urllib.parse.urlencode(params, safe=".,:")


def find_entitlement(email: str) -> dict[str, Any] | None:
    query = query_string(
        {
            "email": f"eq.{email}",
            "order": "updated_at.desc",
            "limit": "1",
        }
    )
    rows = supabase_request("GET", f"/rest/v1/user_entitlements?{query}")
    if isinstance(rows, list) and rows:
        return rows[0]
    return None


def list_usage_events(email: str, since_iso: str | None = None) -> list[dict[str, Any]]:
    params = {
        "email": f"eq.{email}",
        "select": "event_type,units,metadata,created_at",
        "order": "created_at.desc",
        "limit": "1000",
    }
    if since_iso:
        params["created_at"] = f"gte.{since_iso}"
    query = query_string(params)
    rows = supabase_request("GET", f"/rest/v1/usage_events?{query}")
    return rows if isinstance(rows, list) else []


def save_entitlement(email: str, fields: dict[str, Any]) -> dict[str, Any]:
    now = utc_now_iso()
    existing = find_entitlement(email)
    payload = {
        "site_origin": SITE_ORIGIN,
        "source_site": SITE_ORIGIN,
        "grant_source": fields.get("grant_source") or "vid2ppt",
        **fields,
        "email": email,
        "updated_at": now,
    }

    if existing and existing.get("id"):
        query = query_string({"id": f"eq.{existing['id']}", "select": "*"})
        rows = supabase_request("PATCH", f"/rest/v1/user_entitlements?{query}", payload, prefer_return=True)
    else:
        rows = supabase_request("POST", "/rest/v1/user_entitlements?select=*", payload, prefer_return=True)

    if isinstance(rows, list) and rows:
        return rows[0]
    return payload


def insert_usage_event(email: str, event_type: str, metadata: dict[str, Any] | None = None, *, units: int = 1, site_origin: str | None = None) -> None:
    origin = (site_origin or SITE_ORIGIN).strip() or SITE_ORIGIN
    payload = {
        "email": email,
        "event_type": event_type,
        "units": max(1, int(units)),
        "metadata": {"site_origin": origin, **(metadata or {})},
        "site_origin": origin,
    }
    supabase_request("POST", "/rest/v1/usage_events", payload)


def list_recent_rows(table: str, *, select: str = "*", order_column: str = "created_at", limit: int = 500) -> list[dict[str, Any]]:
    if not SAFE_TABLE_RE.match(table):
        raise ValueError("Invalid table name")
    params = {
        "select": select,
        "order": f"{order_column}.desc",
        "limit": str(max(1, min(int(limit), 5000))),
    }
    rows = supabase_request("GET", f"/rest/v1/{table}?{query_string(params)}")
    return rows if isinstance(rows, list) else []


def find_sponsor_order_by_request_id(request_id: str) -> dict[str, Any] | None:
    query = query_string(
        {
            "request_id": f"eq.{request_id}",
            "select": "*",
            "limit": "1",
        }
    )
    rows = supabase_request("GET", f"/rest/v1/sponsor_orders?{query}")
    if isinstance(rows, list) and rows:
        return rows[0]
    return None


def find_sponsor_order_by_code(code: str) -> dict[str, Any] | None:
    query = query_string(
        {
            "code": f"eq.{code}",
            "select": "*",
            "limit": "1",
        }
    )
    rows = supabase_request("GET", f"/rest/v1/sponsor_orders?{query}")
    if isinstance(rows, list) and rows:
        return rows[0]
    return None


def list_sponsor_orders_by_email(email: str, *, limit: int = 500) -> list[dict[str, Any]]:
    query = query_string(
        {
            "email": f"eq.{email}",
            "select": "*",
            "order": "created_at.desc",
            "limit": str(max(1, min(int(limit), 500))),
        }
    )
    rows = supabase_request("GET", f"/rest/v1/sponsor_orders?{query}")
    return rows if isinstance(rows, list) else []


def save_sponsor_order(fields: dict[str, Any]) -> dict[str, Any]:
    request_id = str(fields.get("request_id") or "").strip()
    if not request_id:
        raise ValueError("request_id is required")

    payload = {**fields, "updated_at": utc_now_iso()}
    existing = find_sponsor_order_by_request_id(request_id)
    if existing and existing.get("id"):
        query = query_string({"id": f"eq.{existing['id']}", "select": "*"})
        rows = supabase_request("PATCH", f"/rest/v1/sponsor_orders?{query}", payload, prefer_return=True)
    else:
        rows = supabase_request("POST", "/rest/v1/sponsor_orders?select=*", payload, prefer_return=True)
    if isinstance(rows, list) and rows:
        return rows[0]
    return payload


def update_sponsor_order(order_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    payload = {**fields, "updated_at": utc_now_iso()}
    query = query_string({"id": f"eq.{order_id}", "select": "*"})
    rows = supabase_request("PATCH", f"/rest/v1/sponsor_orders?{query}", payload, prefer_return=True)
    if isinstance(rows, list) and rows:
        return rows[0]
    return payload


def find_site_user_by_username(username: str) -> dict[str, Any] | None:
    query = query_string({"username": f"eq.{username}", "site_origin": f"eq.{SITE_ORIGIN}", "limit": "1"})
    rows = supabase_request("GET", f"/rest/v1/site_users?{query}")
    if isinstance(rows, list) and rows:
        return rows[0]
    fallback = query_string({"username": f"eq.{username}", "limit": "1"})
    rows = supabase_request("GET", f"/rest/v1/site_users?{fallback}")
    if isinstance(rows, list) and rows:
        return rows[0]
    return None


def create_site_user(fields: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "site_origin": SITE_ORIGIN,
        "registered_site": SITE_ORIGIN,
        **fields,
    }
    rows = supabase_request("POST", "/rest/v1/site_users?select=*", payload, prefer_return=True)
    if isinstance(rows, list) and rows:
        return rows[0]
    return fields


def update_site_user(user_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    payload = {**fields, "updated_at": utc_now_iso()}
    query = query_string({"id": f"eq.{user_id}", "select": "*"})
    rows = supabase_request("PATCH", f"/rest/v1/site_users?{query}", payload, prefer_return=True)
    if isinstance(rows, list) and rows:
        return rows[0]
    return payload
