"""Convenience helpers for recording workflow events from live runtime paths."""
from __future__ import annotations

import asyncio
import logging
from typing import Any, TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


def _session_id(session: "SessionState") -> str:
    return (getattr(session, "session_id", "") or getattr(session, "call_sid", "") or "").strip()


async def emit_workflow_event(
    session: "SessionState",
    event_type: str,
    payload: Optional[dict[str, Any]] = None,
    *,
    turn_id: str = "",
) -> None:
    from .event_store import record_workflow_event

    sid = _session_id(session)
    if not sid:
        return
    await record_workflow_event(
        sid,
        turn_id or "",
        event_type,
        payload,
        session=session,
    )


def schedule_workflow_event(
    session: "SessionState",
    event_type: str,
    payload: Optional[dict[str, Any]] = None,
    *,
    turn_id: str = "",
) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(
        emit_workflow_event(session, event_type, payload, turn_id=turn_id)
    )
