"""
Structured tool-event logging — no raw PII.
"""
from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from typing import Any, Iterator

logger = logging.getLogger(__name__)


def _sid(session: Any) -> str:
    return (getattr(session, "call_sid", "") or "")[:8]


def _session_id(session: Any) -> str:
    return (getattr(session, "session_id", "") or getattr(session, "call_sid", "") or "")[:12]


@contextmanager
def tool_event(
    *,
    session: Any,
    tool_name: str,
    turn_id: str = "",
    external_service: str = "",
) -> Iterator[dict[str, Any]]:
    """Log tool started/succeeded/failed with latency."""
    ctx = {
        "session_id": _session_id(session),
        "call_sid": _sid(session),
        "turn_id": turn_id or "",
        "tool_name": tool_name,
        "external_service": external_service,
    }
    t0 = time.monotonic()
    logger.info(
        "tool_event=started session_id=%s call_sid=%s turn_id=%s tool_name=%s external_service=%s",
        ctx["session_id"],
        ctx["call_sid"],
        ctx["turn_id"],
        tool_name,
        external_service,
    )
    try:
        yield ctx
        latency_ms = (time.monotonic() - t0) * 1000
        logger.info(
            "tool_event=succeeded session_id=%s call_sid=%s turn_id=%s tool_name=%s "
            "latency_ms=%.0f external_service=%s",
            ctx["session_id"],
            ctx["call_sid"],
            ctx["turn_id"],
            tool_name,
            latency_ms,
            external_service,
        )
    except TimeoutError:
        latency_ms = (time.monotonic() - t0) * 1000
        logger.warning(
            "tool_event=timed_out session_id=%s call_sid=%s turn_id=%s tool_name=%s "
            "latency_ms=%.0f error_type=timeout",
            ctx["session_id"],
            ctx["call_sid"],
            ctx["turn_id"],
            tool_name,
            latency_ms,
        )
        raise
    except Exception as exc:
        latency_ms = (time.monotonic() - t0) * 1000
        logger.warning(
            "tool_event=failed session_id=%s call_sid=%s turn_id=%s tool_name=%s "
            "latency_ms=%.0f error_type=%s safe_error_code=%s",
            ctx["session_id"],
            ctx["call_sid"],
            ctx["turn_id"],
            tool_name,
            latency_ms,
            type(exc).__name__,
            getattr(exc, "code", "") or "",
        )
        raise


def log_tool_blocked(
    *,
    session: Any,
    tool_name: str,
    reason: str,
    turn_id: str = "",
) -> None:
    logger.info(
        "tool_event=blocked_by_guard session_id=%s call_sid=%s turn_id=%s "
        "tool_name=%s safe_error_code=%s",
        _session_id(session),
        _sid(session),
        turn_id or "",
        tool_name,
        reason,
    )
