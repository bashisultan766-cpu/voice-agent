"""
Workflow event store — records orchestration timeline for replay and debugging.

All payloads are masked before persistence. Secrets and raw PII are excluded from replay.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from ..db import connection as db
from ..db.pii_masking import mask_payload, payload_to_json
from ..memory.postgres_store import persist_call_session_if_configured

logger = logging.getLogger(__name__)

WORKFLOW_EVENT_TYPES = frozenset({
    "call_started",
    "user_turn_received",
    "supervisor_result",
    "planner_result",
    "tool_started",
    "tool_succeeded",
    "tool_failed",
    "composer_result",
    "response_sent",
    "escalation_created",
    "payment_link_created",
    "call_ended",
})

_REPLAY_EXCLUDE_KEYS = frozenset({
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "token",
    "secret",
    "password",
    "card",
    "cvv",
    "raw_email",
    "confirmed_email",
    "pending_email",
})


async def record_workflow_event(
    session_id: str,
    turn_id: str,
    event_type: str,
    payload: Optional[dict[str, Any]] = None,
    *,
    session: Any = None,
) -> None:
    """Persist one workflow event (masked). Ensures call_sessions row exists."""
    if not db.db_configured():
        return
    if event_type not in WORKFLOW_EVENT_TYPES:
        logger.debug("workflow_event_unknown type=%s", event_type)
    if session is not None:
        persist_call_session_if_configured(session)
    masked_json = payload_to_json(payload or {})
    await db.execute_write(
        """
        INSERT INTO workflow_events (session_id, turn_id, event_type, payload_masked)
        VALUES ($1, $2, $3, $4)
        """,
        session_id,
        turn_id or "",
        event_type,
        masked_json,
    )


async def get_session_timeline(session_id: str) -> list[dict[str, Any]]:
    """Return all workflow events for a session in chronological order."""
    rows = await db.fetch_rows(
        """
        SELECT id, session_id, turn_id, event_type, payload_masked, created_at
        FROM workflow_events
        WHERE session_id = $1
        ORDER BY created_at ASC, id ASC
        """,
        session_id,
    )
    return [_row_to_event(row) for row in rows]


async def get_turn_events(session_id: str, turn_id: str) -> list[dict[str, Any]]:
    """Return workflow events for one turn."""
    rows = await db.fetch_rows(
        """
        SELECT id, session_id, turn_id, event_type, payload_masked, created_at
        FROM workflow_events
        WHERE session_id = $1 AND turn_id = $2
        ORDER BY created_at ASC, id ASC
        """,
        session_id,
        turn_id,
    )
    return [_row_to_event(row) for row in rows]


async def replay_session(session_id: str) -> dict[str, Any]:
    """
    Build a sanitized replay view — timeline plus session metadata.
    Excludes secret keys from nested payloads.
    """
    session_rows = await db.fetch_rows(
        """
        SELECT id, call_sid, phone_masked, started_at, ended_at, status, summary, runtime_mode
        FROM call_sessions
        WHERE id = $1
        LIMIT 1
        """,
        session_id,
    )
    timeline = await get_session_timeline(session_id)
    tool_rows = await db.fetch_rows(
        """
        SELECT tool_name, status, turn_id, error_code, latency_ms, created_at
        FROM tool_events
        WHERE session_id = $1
        ORDER BY created_at ASC
        """,
        session_id,
    )
    return {
        "session": session_rows[0] if session_rows else None,
        "timeline": [_sanitize_replay_event(ev) for ev in timeline],
        "tool_events": [
            {
                "tool_name": r.get("tool_name"),
                "status": r.get("status"),
                "turn_id": r.get("turn_id"),
                "error_code": r.get("error_code"),
                "latency_ms": r.get("latency_ms"),
                "created_at": _iso(r.get("created_at")),
            }
            for r in tool_rows
        ],
    }


def _row_to_event(row: dict[str, Any]) -> dict[str, Any]:
    import json

    payload_raw = row.get("payload_masked") or "{}"
    try:
        payload = json.loads(payload_raw) if isinstance(payload_raw, str) else payload_raw
    except (json.JSONDecodeError, TypeError):
        payload = {}
    return {
        "id": row.get("id"),
        "session_id": row.get("session_id"),
        "turn_id": row.get("turn_id") or "",
        "event_type": row.get("event_type"),
        "payload": payload if isinstance(payload, dict) else {},
        "created_at": _iso(row.get("created_at")),
    }


def _sanitize_replay_event(event: dict[str, Any]) -> dict[str, Any]:
    payload = event.get("payload") or {}
    cleaned = _strip_secrets_from_payload(payload)
    return {
        "turn_id": event.get("turn_id"),
        "event_type": event.get("event_type"),
        "payload": cleaned,
        "created_at": event.get("created_at"),
    }


def _strip_secrets_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    masked = mask_payload(payload)
    return {k: v for k, v in masked.items() if str(k).lower() not in _REPLAY_EXCLUDE_KEYS}


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)
