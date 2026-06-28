from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any


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
    payload = {**fields, "email": email, "updated_at": now}

    if existing and existing.get("id"):
        query = query_string({"id": f"eq.{existing['id']}", "select": "*"})
        rows = supabase_request("PATCH", f"/rest/v1/user_entitlements?{query}", payload, prefer_return=True)
    else:
        rows = supabase_request("POST", "/rest/v1/user_entitlements?select=*", payload, prefer_return=True)

    if isinstance(rows, list) and rows:
        return rows[0]
    return payload


def insert_usage_event(email: str, event_type: str, metadata: dict[str, Any] | None = None, *, units: int = 1) -> None:
    payload = {
        "email": email,
        "event_type": event_type,
        "units": max(1, int(units)),
        "metadata": metadata or {},
    }
    supabase_request("POST", "/rest/v1/usage_events", payload)


def find_site_user_by_username(username: str) -> dict[str, Any] | None:
    query = query_string(
        {
            "username": f"eq.{username}",
            "limit": "1",
        }
    )
    rows = supabase_request("GET", f"/rest/v1/site_users?{query}")
    if isinstance(rows, list) and rows:
        return rows[0]
    return None


def create_site_user(fields: dict[str, Any]) -> dict[str, Any]:
    rows = supabase_request("POST", "/rest/v1/site_users?select=*", fields, prefer_return=True)
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
