"""
Admin debug endpoints — session timeline and replay (dev/staging only).

Requires ENABLE_ADMIN_DEBUG_ENDPOINTS=true and X-Admin-Key header.
"""
from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from ..config import get_settings
from ..security.rate_limit import rate_limit_dependency
from ..workflow.event_store import get_session_timeline, replay_session

logger = logging.getLogger(__name__)

admin_debug_router = APIRouter(tags=["admin-debug"])


def _require_admin_debug_enabled() -> None:
    settings = get_settings()
    if not settings.ENABLE_ADMIN_DEBUG_ENDPOINTS:
        raise HTTPException(status_code=404, detail="Not found")


def _verify_admin_key(request: Request) -> None:
    settings = get_settings()
    admin_key = (settings.INTERNAL_ADMIN_KEY or "").strip()
    if not admin_key:
        raise HTTPException(status_code=403, detail="Admin debug not configured")
    provided = request.headers.get("x-admin-key", "")
    if not hmac.compare_digest(provided, admin_key):
        raise HTTPException(status_code=403, detail="Forbidden")


@admin_debug_router.get(
    "/admin/sessions/{session_id}/timeline",
    dependencies=[
        Depends(rate_limit_dependency("admin_debug", limit=30, window_sec=60)),
    ],
)
async def session_timeline(session_id: str, request: Request) -> dict:
    """Return chronological workflow events for a session."""
    _require_admin_debug_enabled()
    _verify_admin_key(request)
    events = await get_session_timeline(session_id)
    return {"session_id": session_id, "events": events, "count": len(events)}


@admin_debug_router.get(
    "/admin/sessions/{session_id}/replay",
    dependencies=[
        Depends(rate_limit_dependency("admin_debug", limit=20, window_sec=60)),
    ],
)
async def session_replay(session_id: str, request: Request) -> dict:
    """Return sanitized session replay (no secrets)."""
    _require_admin_debug_enabled()
    _verify_admin_key(request)
    replay = await replay_session(session_id)
    return {"session_id": session_id, **replay}
