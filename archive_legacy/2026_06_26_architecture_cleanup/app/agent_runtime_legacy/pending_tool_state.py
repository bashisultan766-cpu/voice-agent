"""Pending tool execution state per call (v4.14.4)."""
from __future__ import annotations

import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

_PENDING: dict[str, "PendingToolState"] = {}

_STATUS_QUERY_PAT = re.compile(
    r"\b("
    r"did you find (?:it|this|that|the book|anything)|"
    r"any update|what happened|are you still there|still checking|"
    r"did you look (?:it )?up|found (?:it|anything)|"
    r"what did you find"
    r")\b",
    re.I,
)

_RUNNING_RESPONSE = "I'm still checking that. One moment."
_FAILED_RESPONSE = (
    "I had trouble checking that. I can try again or send this to customer service."
)
_GRACEFUL_WORKER_FAILURE = (
    "I had trouble checking that right now. I can try again or send this to customer service."
)


@dataclass
class PendingToolState:
    pending_tool_id: str
    intent: str
    categories: list[str] = field(default_factory=list)
    entities: dict[str, str] = field(default_factory=dict)
    status: str = "running"
    started_at: float = 0.0
    completed_at: float = 0.0
    facts_summary: str = ""
    last_tool_answer: str = ""


def is_pending_tool_status_query(text: str) -> bool:
    return bool(_STATUS_QUERY_PAT.search((text or "").strip()))


def start_pending_tool(
    call_sid: str,
    intent: str,
    categories: list[str],
    entities: dict[str, str],
) -> PendingToolState:
    state = PendingToolState(
        pending_tool_id=str(uuid.uuid4())[:8],
        intent=intent,
        categories=list(categories),
        entities=dict(entities),
        status="running",
        started_at=time.monotonic(),
    )
    _PENDING[call_sid] = state
    logger.info(
        "pending_tool_started sid=%s id=%s intent=%s categories=%s",
        call_sid[:6], state.pending_tool_id, intent, categories,
    )
    return state


def complete_pending_tool(
    call_sid: str,
    facts_summary: str,
    last_tool_answer: str,
) -> Optional[PendingToolState]:
    state = _PENDING.get(call_sid)
    if not state:
        return None
    state.status = "completed"
    state.completed_at = time.monotonic()
    state.facts_summary = facts_summary
    state.last_tool_answer = last_tool_answer
    logger.info(
        "pending_tool_completed sid=%s id=%s facts=%s",
        call_sid[:6], state.pending_tool_id, len(facts_summary),
    )
    return state


def fail_pending_tool(call_sid: str, reason: str = "") -> Optional[PendingToolState]:
    state = _PENDING.get(call_sid)
    if not state:
        return None
    state.status = "failed"
    state.completed_at = time.monotonic()
    state.facts_summary = reason
    logger.info("pending_tool_failed sid=%s id=%s reason=%s", call_sid[:6], state.pending_tool_id, reason[:40])
    return state


def get_pending_tool(call_sid: str) -> Optional[PendingToolState]:
    return _PENDING.get(call_sid)


def clear_pending_tool(call_sid: str) -> None:
    _PENDING.pop(call_sid, None)


def handle_pending_tool_status_query(
    call_sid: str,
    text: str,
    expected_next: str = "",
) -> Optional[str]:
    """Return a direct answer for tool-status follow-ups, or None."""
    if not is_pending_tool_status_query(text):
        return None

    state = get_pending_tool(call_sid)
    if not state:
        if expected_next in {"isbn_number", "isbn_digits", "isbn_13_digits", "book_title"}:
            return "Go ahead. I'm still here whenever you're ready."
        return None

    if state.status == "running":
        return _RUNNING_RESPONSE
    if state.status == "completed" and state.last_tool_answer:
        return state.last_tool_answer
    if state.status == "failed":
        return _FAILED_RESPONSE
    return _RUNNING_RESPONSE
