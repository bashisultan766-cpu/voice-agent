"""
Admin analytics endpoints — platform metrics and evaluations.

Requires ENABLE_ADMIN_DEBUG_ENDPOINTS=true and X-Admin-Key. No secrets or raw PII.
"""
from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from ..analytics.metrics_collector import (
    collect_aggregate_summary,
    list_evaluations,
    list_failures,
    list_recent_calls,
)
from ..config import get_settings
from ..security.rate_limit import rate_limit_dependency

logger = logging.getLogger(__name__)

admin_analytics_router = APIRouter(tags=["admin-analytics"])


def _require_admin_debug_enabled() -> None:
    if not get_settings().ENABLE_ADMIN_DEBUG_ENDPOINTS:
        raise HTTPException(status_code=404, detail="Not found")


def _verify_admin_key(request: Request) -> None:
    settings = get_settings()
    admin_key = (settings.INTERNAL_ADMIN_KEY or "").strip()
    if not admin_key:
        raise HTTPException(status_code=403, detail="Admin analytics not configured")
    provided = request.headers.get("x-admin-key", "")
    if not hmac.compare_digest(provided, admin_key):
        raise HTTPException(status_code=403, detail="Forbidden")


@admin_analytics_router.get(
    "/admin/analytics/summary",
    dependencies=[Depends(rate_limit_dependency("admin_analytics", limit=20, window_sec=60))],
)
async def analytics_summary(request: Request, days: int = 7) -> dict:
    _require_admin_debug_enabled()
    _verify_admin_key(request)
    summary = await collect_aggregate_summary(days=max(1, min(days, 90)))
    return {"summary": summary}


@admin_analytics_router.get(
    "/admin/analytics/calls",
    dependencies=[Depends(rate_limit_dependency("admin_analytics", limit=30, window_sec=60))],
)
async def analytics_calls(request: Request, limit: int = 50, days: int = 7) -> dict:
    _require_admin_debug_enabled()
    _verify_admin_key(request)
    calls = await list_recent_calls(limit=max(1, min(limit, 200)), days=max(1, min(days, 90)))
    return {"calls": calls, "count": len(calls)}


@admin_analytics_router.get(
    "/admin/analytics/failures",
    dependencies=[Depends(rate_limit_dependency("admin_analytics", limit=20, window_sec=60))],
)
async def analytics_failures(request: Request, days: int = 7) -> dict:
    _require_admin_debug_enabled()
    _verify_admin_key(request)
    failures = await list_failures(days=max(1, min(days, 90)))
    return failures


@admin_analytics_router.get(
    "/admin/analytics/evaluations",
    dependencies=[Depends(rate_limit_dependency("admin_analytics", limit=30, window_sec=60))],
)
async def analytics_evaluations(request: Request, limit: int = 50, days: int = 7) -> dict:
    _require_admin_debug_enabled()
    _verify_admin_key(request)
    evaluations = await list_evaluations(limit=max(1, min(limit, 200)), days=max(1, min(days, 90)))
    return {"evaluations": evaluations, "count": len(evaluations)}
