from __future__ import annotations

from typing import Any


PLAN_LIMITS: dict[str, dict[str, Any]] = {
    "free": {
        "video_max_minutes": 10,
        "video_conversions_monthly": 3,
        "editable_slides_monthly": 100,
        "transcribe_minutes_monthly": 600,
        "batch_processing": False,
        "image_pptx": True,
        "screen_recording": True,
    },
    "day_pass": {
        "video_max_minutes": 10,
        "video_conversions_monthly": 20,
        "editable_slides_monthly": 300,
        "transcribe_minutes_monthly": 120,
        "batch_processing": False,
        "image_pptx": True,
        "screen_recording": True,
    },
    "pro": {
        "video_max_minutes": None,
        "video_conversions_monthly": 100,
        "editable_slides_monthly": 10000,
        "transcribe_minutes_monthly": None,
        "batch_processing": True,
        "image_pptx": True,
        "screen_recording": True,
    },
    "lifetime": {
        "video_max_minutes": None,
        "video_conversions_monthly": None,
        "editable_slides_monthly": None,
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
