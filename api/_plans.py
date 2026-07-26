from __future__ import annotations

import os
from typing import Any


PLAN_LIMITS: dict[str, dict[str, Any]] = {
    "free": {
        "video_max_minutes": 10,
        "video_conversions_monthly": 3,
        "editable_slides_monthly": 100,
        "summary_generations_monthly": 10,
        "transcribe_minutes_monthly": 600,
        "batch_processing": False,
        "image_pptx": True,
        "screen_recording": True,
    },
    "day_pass": {
        "video_max_minutes": 10,
        "video_conversions_monthly": 20,
        "editable_slides_monthly": 300,
        "summary_generations_monthly": None,
        "transcribe_minutes_monthly": 120,
        "batch_processing": False,
        "image_pptx": True,
        "screen_recording": True,
    },
    "pro": {
        "video_max_minutes": None,
        "video_conversions_monthly": 100,
        "editable_slides_monthly": 10000,
        "summary_generations_monthly": None,
        "transcribe_minutes_monthly": None,
        "batch_processing": True,
        "image_pptx": True,
        "screen_recording": True,
    },
    "lifetime": {
        "video_max_minutes": None,
        "video_conversions_monthly": None,
        "editable_slides_monthly": None,
        "summary_generations_monthly": None,
        "transcribe_minutes_monthly": None,
        "batch_processing": True,
        "image_pptx": True,
        "screen_recording": True,
    },
}


PLAN_LABELS = {
    "free": "免费版",
    "day_pass": "临时版",
    "pro": "专业版",
    "lifetime": "终身版",
}


DEFAULT_OWNER_USERNAMES = {"kcdesk", "twotigers_vid"}


def is_owner_identity(email: str = "", username: str = "") -> bool:
    configured_usernames = csv_set(os.getenv("VID2PPT_OWNER_USERNAMES", ""))
    configured_emails = csv_set(os.getenv("VID2PPT_OWNER_EMAILS", ""))
    owner_usernames = DEFAULT_OWNER_USERNAMES | configured_usernames
    normalized_username = (username or "").strip().lower().removeprefix("@")
    normalized_email = (email or "").strip().lower()
    if normalized_username and normalized_username in owner_usernames:
        return True
    if normalized_email and normalized_email in configured_emails:
        return True
    return normalized_email in {f"{name}@users.vid2ppt.com" for name in owner_usernames}


def csv_set(value: str) -> set[str]:
    return {item.strip().lower() for item in value.split(",") if item.strip()}


def effective_plan(plan: str, active: bool) -> str:
    normalized = (plan or "free").strip().lower()
    if not active:
        return "free"
    if normalized not in PLAN_LIMITS:
        return "free"
    return normalized


def plan_limits(plan: str) -> dict[str, Any]:
    limits = PLAN_LIMITS.get(plan) or PLAN_LIMITS["free"]
    return dict(limits)


def plan_label(plan: str) -> str:
    return PLAN_LABELS.get(plan, PLAN_LABELS["free"])
