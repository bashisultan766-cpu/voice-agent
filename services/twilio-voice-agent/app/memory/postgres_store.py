"""
Postgres persistence — async writes when DATABASE_URL is configured.

Masks email/phone/payment URLs before storage. Never stores API keys or raw card data.
Write failures are non-fatal in development; production logs and continues unless
STRICT_POSTGRES=true.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Optional

from ..db import connection as db
from ..db.pii_masking import (
    hash_phone,
    mask_email,
    mask_payment_url,
    mask_phone,
    mask_text,
    payload_to_json,
)

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


def _runtime_mode() -> str:
    from ..config import get_settings

    s = get_settings()
    if getattr(s, "VOICE_ORCHESTRATOR_ENABLED", True):
        return "orchestrator"
    return getattr(s, "VOICE_AGENT_RUNTIME_MODE", "") or "llm_tool_runtime"


def _session_id(session: "SessionState") -> str:
    return (getattr(session, "session_id", "") or getattr(session, "call_sid", "") or "unknown").strip()


async def _ensure_call_session_row(session: "SessionState", *, status: str = "active") -> None:
    sid = _session_id(session)
    phone = mask_phone(getattr(session, "from_number", "") or "")
    await db.execute_write(
        """
        INSERT INTO call_sessions (id, call_sid, phone_masked, status, runtime_mode)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
            phone_masked = EXCLUDED.phone_masked,
            status = EXCLUDED.status,
            runtime_mode = EXCLUDED.runtime_mode
        """,
        sid,
        getattr(session, "call_sid", "") or "",
        phone,
        status,
        _runtime_mode(),
    )


async def _persist_turn_async(
    session: "SessionState",
    *,
    user_text: str,
    assistant_text: str,
    source: str,
    turn_id: str = "",
    latency_ms: float = 0.0,
) -> None:
    await _ensure_call_session_row(session)
    sid = _session_id(session)
    await db.execute_write(
        """
        INSERT INTO conversation_turns
            (session_id, turn_id, role, content_masked, latency_ms)
        VALUES ($1, $2, 'user', $3, $4)
        """,
        sid,
        turn_id,
        mask_text(user_text or ""),
        latency_ms,
    )
    await db.execute_write(
        """
        INSERT INTO conversation_turns
            (session_id, turn_id, role, content_masked, latency_ms)
        VALUES ($1, $2, 'assistant', $3, 0)
        """,
        sid,
        turn_id,
        mask_text(assistant_text or ""),
    )
    logger.debug(
        "postgres_turn_persisted session=%s source=%s turn_id=%s",
        sid[:8],
        source,
        turn_id[:8] if turn_id else "",
    )


async def _persist_call_session_async(
    session: "SessionState",
    *,
    status: str = "active",
    summary: str = "",
    ended: bool = False,
) -> None:
    sid = _session_id(session)
    if ended:
        await db.execute_write(
            """
            INSERT INTO call_sessions (id, call_sid, phone_masked, status, summary, runtime_mode, ended_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id) DO UPDATE SET
                status = EXCLUDED.status,
                summary = EXCLUDED.summary,
                ended_at = EXCLUDED.ended_at,
                runtime_mode = EXCLUDED.runtime_mode
            """,
            sid,
            getattr(session, "call_sid", "") or "",
            mask_phone(getattr(session, "from_number", "") or ""),
            status,
            mask_text(summary or ""),
            _runtime_mode(),
            datetime.now(timezone.utc),
        )
    else:
        await _ensure_call_session_row(session, status=status)
        if summary:
            await db.execute_write(
                "UPDATE call_sessions SET summary = $2 WHERE id = $1",
                sid,
                mask_text(summary),
            )
    await _upsert_customer_profile_async(session, summary=summary)


async def _upsert_customer_profile_async(session: "SessionState", *, summary: str = "") -> None:
    phone_hash = hash_phone(getattr(session, "from_number", "") or "")
    if not phone_hash:
        return
    name = (getattr(session, "caller_name", "") or "")[:80]
    email = getattr(session, "confirmed_email", "") or getattr(session, "caller_email", "") or ""
    email_masked = mask_email(email) if email else ""
    last_summary = mask_text(summary or getattr(session, "caller_last_summary", "") or "")
    await db.execute_write(
        """
        INSERT INTO customer_profiles (phone_hash, name, email_masked, last_summary)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (phone_hash) DO UPDATE SET
            name = COALESCE(NULLIF(EXCLUDED.name, ''), customer_profiles.name),
            email_masked = COALESCE(NULLIF(EXCLUDED.email_masked, ''), customer_profiles.email_masked),
            last_summary = COALESCE(NULLIF(EXCLUDED.last_summary, ''), customer_profiles.last_summary),
            updated_at = NOW()
        """,
        phone_hash,
        name,
        email_masked,
        last_summary,
    )


async def _persist_payment_link_async(
    session: "SessionState",
    *,
    email: str,
    checkout_url: str = "",
    draft_order_id: str = "",
    status: str = "sent",
) -> None:
    await _ensure_call_session_row(session)
    sid = _session_id(session)
    await db.execute_write(
        """
        INSERT INTO payment_links
            (session_id, draft_order_id, url_masked, sent_to_masked, status)
        VALUES ($1, $2, $3, $4, $5)
        """,
        sid,
        (draft_order_id or getattr(session, "pending_draft_order_id", "") or "")[:64],
        mask_payment_url(checkout_url or getattr(session, "pending_checkout_url", "") or ""),
        mask_email(email),
        status,
    )


async def _persist_tool_event_async(
    session: "SessionState",
    *,
    tool_name: str,
    success: bool,
    latency_ms: float = 0.0,
    error_code: str = "",
    turn_id: str = "",
    input_data: Optional[dict[str, Any]] = None,
    output_data: Optional[dict[str, Any]] = None,
) -> None:
    await _ensure_call_session_row(session)
    sid = _session_id(session)
    status = "succeeded" if success else "failed"
    await db.execute_write(
        """
        INSERT INTO tool_events
            (session_id, turn_id, tool_name, status, input_masked, output_masked,
             error_code, latency_ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        """,
        sid,
        turn_id,
        tool_name,
        status,
        payload_to_json(input_data or {}),
        payload_to_json(output_data or {}),
        error_code or "",
        float(latency_ms or 0),
    )


async def _persist_escalation_async(
    session: "SessionState",
    *,
    escalation_type: str,
    payload: Optional[dict[str, Any]] = None,
    status: str = "created",
) -> None:
    await _ensure_call_session_row(session)
    sid = _session_id(session)
    await db.execute_write(
        """
        INSERT INTO escalations (session_id, type, payload_masked, status)
        VALUES ($1, $2, $3, $4)
        """,
        sid,
        escalation_type,
        payload_to_json(payload or {}),
        status,
    )


async def _load_call_resume_async(call_sid: str) -> dict[str, Any] | None:
    rows = await db.fetch_rows(
        """
        SELECT summary, status, runtime_mode, started_at, ended_at
        FROM call_sessions
        WHERE call_sid = $1
        ORDER BY started_at DESC
        LIMIT 1
        """,
        call_sid,
    )
    if not rows:
        return None
    row = rows[0]
    return {
        "summary": row.get("summary") or "",
        "status": row.get("status") or "",
        "runtime_mode": row.get("runtime_mode") or "",
    }


def _schedule(coro) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(coro)


def persist_turn_if_configured(
    session: "SessionState",
    *,
    user_text: str,
    assistant_text: str,
    source: str = "orchestrator",
    turn_id: str = "",
    latency_ms: float = 0.0,
) -> None:
    if not db.db_configured():
        return
    _schedule(
        _persist_turn_async(
            session,
            user_text=user_text,
            assistant_text=assistant_text,
            source=source,
            turn_id=turn_id,
            latency_ms=latency_ms,
        )
    )


def persist_call_session_if_configured(
    session: "SessionState",
    *,
    status: str = "active",
    summary: str = "",
    ended: bool = False,
) -> None:
    if not db.db_configured():
        return
    _schedule(
        _persist_call_session_async(
            session,
            status=status,
            summary=summary,
            ended=ended,
        )
    )


def persist_payment_link_if_configured(
    session: "SessionState",
    *,
    email: str,
    checkout_url: str = "",
    draft_order_id: str = "",
) -> None:
    if not db.db_configured():
        return
    _schedule(
        _persist_payment_link_async(
            session,
            email=email,
            checkout_url=checkout_url,
            draft_order_id=draft_order_id,
        )
    )


def persist_tool_event_if_configured(
    session: "SessionState",
    *,
    tool_name: str,
    success: bool,
    latency_ms: float = 0.0,
    error_code: str = "",
    turn_id: str = "",
    input_data: Optional[dict[str, Any]] = None,
    output_data: Optional[dict[str, Any]] = None,
) -> None:
    if not db.db_configured():
        return
    _schedule(
        _persist_tool_event_async(
            session,
            tool_name=tool_name,
            success=success,
            latency_ms=latency_ms,
            error_code=error_code,
            turn_id=turn_id,
            input_data=input_data,
            output_data=output_data,
        )
    )


def persist_escalation_if_configured(
    session: "SessionState",
    *,
    escalation_type: str,
    payload: Optional[dict[str, Any]] = None,
) -> None:
    if not db.db_configured():
        return
    _schedule(
        _persist_escalation_async(
            session,
            escalation_type=escalation_type,
            payload=payload,
        )
    )


def load_call_resume_if_configured(call_sid: str) -> dict[str, Any] | None:
    """Load call resume snapshot from Postgres when configured (sync wrapper)."""
    if not db.db_configured():
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    try:
        return loop.run_until_complete(_load_call_resume_async(call_sid))
    except Exception:
        return None


async def persist_call_session_async(
    session: "SessionState",
    *,
    status: str = "active",
    summary: str = "",
    ended: bool = False,
) -> None:
    if not db.db_configured():
        return
    await _persist_call_session_async(session, status=status, summary=summary, ended=ended)
