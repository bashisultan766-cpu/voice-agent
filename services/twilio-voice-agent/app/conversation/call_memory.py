"""
Call memory — 50-turn working memory for live voice (v4.6).

Stores safe user/assistant turns, rolling summary, and key facts.
Never stores role=tool or OpenAI tool calls.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_MAX_TURNS = 50
_VERBATIM_TURNS = 12
_FORBIDDEN_ROLES = frozenset({"tool", "function"})


@dataclass
class CallMemoryState:
    user_turns: list[str] = field(default_factory=list)
    assistant_turns: list[str] = field(default_factory=list)
    rolling_summary: str = ""
    important_facts: list[str] = field(default_factory=list)
    cart_facts: list[str] = field(default_factory=list)
    isbns_provided: list[str] = field(default_factory=list)
    email_state: str = "none"
    order_context: str = ""
    refund_context: str = ""
    facility_context: str = ""
    current_topic: str = ""
    customer_mood: str = "normal"


def get_call_memory(session: "SessionState") -> CallMemoryState:
    raw = getattr(session, "call_memory", None)
    if isinstance(raw, CallMemoryState):
        return raw
    if isinstance(raw, dict):
        state = CallMemoryState()
        for key in CallMemoryState.__dataclass_fields__:
            if key in raw:
                setattr(state, key, raw[key])
        session.call_memory = state
        return state
    state = CallMemoryState()
    session.call_memory = state
    return state


def _mask_for_log(text: str) -> str:
    if not text:
        return ""
    masked = re.sub(
        r"[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}",
        "***@***",
        text,
        flags=re.IGNORECASE,
    )
    if len(masked) > 80:
        return masked[:77] + "..."
    return masked


def _trim_turns(turns: list[str]) -> list[str]:
    if len(turns) > _MAX_TURNS:
        return turns[-_MAX_TURNS:]
    return turns


def _append_fact(state: CallMemoryState, fact: str) -> None:
    if fact and fact not in state.important_facts:
        state.important_facts.append(fact)
    if len(state.important_facts) > 40:
        state.important_facts = state.important_facts[-40:]


def _rebuild_rolling_summary(state: CallMemoryState) -> None:
    """Compress older turns beyond verbatim window into a short summary."""
    total = len(state.user_turns)
    if total <= _VERBATIM_TURNS:
        return

    older_user = state.user_turns[: total - _VERBATIM_TURNS]
    older_assistant = state.assistant_turns[: max(0, len(state.assistant_turns) - _VERBATIM_TURNS)]

    snippets: list[str] = []
    for i, ut in enumerate(older_user[-10:]):
        snippets.append(f"Customer: {_mask_for_log(ut)}")
        if i < len(older_assistant):
            snippets.append(f"Agent: {_mask_for_log(older_assistant[i])}")

    if state.important_facts:
        snippets.append("Facts: " + "; ".join(state.important_facts[-8:]))

    state.rolling_summary = " | ".join(snippets)[:1200]


def record_user_turn(session: "SessionState", text: str, intent: str = "") -> None:
    if not text or not text.strip():
        return
    state = get_call_memory(session)
    state.user_turns = _trim_turns(state.user_turns + [text.strip()])

    if intent:
        state.current_topic = intent.replace("_", " ")

    mood = getattr(getattr(session, "dialogue", None), "customer_mood", "")
    if mood:
        state.customer_mood = mood

    _rebuild_rolling_summary(state)
    logger.debug(
        "call_memory user_turn sid=%s count=%d topic=%s",
        session.call_sid[:6],
        len(state.user_turns),
        _mask_for_log(state.current_topic),
    )


def record_assistant_turn(session: "SessionState", text: str) -> None:
    if not text or not text.strip():
        return
    state = get_call_memory(session)
    state.assistant_turns = _trim_turns(state.assistant_turns + [text.strip()])
    _rebuild_rolling_summary(state)


def record_isbn(session: "SessionState", isbn: str) -> None:
    state = get_call_memory(session)
    if isbn and isbn not in state.isbns_provided:
        state.isbns_provided.append(isbn)
        _append_fact(state, f"Customer gave ISBN {isbn}")


def record_product_candidate(session: "SessionState", title: str, found: bool) -> None:
    state = get_call_memory(session)
    if found and title:
        _append_fact(state, f"Product candidate found: {title[:60]}")
    elif not found:
        _append_fact(state, "Product candidate not found")


def record_cart_confirmed(session: "SessionState", title: str, count: int) -> None:
    state = get_call_memory(session)
    state.cart_facts.append(f"Confirmed: {title[:50]}")
    _append_fact(state, f"Cart count: {count}")


def sync_email_state(session: "SessionState") -> None:
    state = get_call_memory(session)
    confirmed = getattr(session, "confirmed_email", "") or ""
    pending = getattr(session, "pending_email", "") or ""
    rejected = getattr(session, "email_rejected_count", 0) or 0

    if confirmed:
        state.email_state = "confirmed"
        _append_fact(state, "Customer confirmed email")
    elif pending:
        state.email_state = "pending"
        _append_fact(state, "Customer provided email")
    elif rejected:
        state.email_state = "rejected"
        _append_fact(state, "Email rejected or corrected")


def sync_payment_state(session: "SessionState") -> None:
    pfs = getattr(session, "payment_flow_status", "idle") or "idle"
    state = get_call_memory(session)
    if pfs != "idle":
        _append_fact(state, f"Payment status: {pfs}")

    pfr = getattr(session, "payment_flow_result", {}) or {}
    if pfr.get("email_sent"):
        _append_fact(state, "Payment link sent")


def sync_facility_context(session: "SessionState") -> None:
    name = getattr(session, "last_facility_name", "") or ""
    if name:
        state = get_call_memory(session)
        state.facility_context = name[:60]
        _append_fact(state, f"Facility mentioned: {name[:40]}")


def sync_from_session(session: "SessionState") -> None:
    """Refresh facts from session state after workers run."""
    state = get_call_memory(session)

    for isbn in getattr(session, "isbn_history", []) or []:
        if isbn not in state.isbns_provided:
            state.isbns_provided.append(isbn)

    try:
        from ..cart.session import get_ledger
        ledger = get_ledger(session)
        n = ledger.confirmed_count()
        if n:
            state.cart_facts = [f"{n} book(s) in cart"]
            _append_fact(state, f"Cart count: {n}")
    except Exception:
        pass

    if session.last_order_number:
        state.order_context = session.last_order_number
        _append_fact(state, f"Order number: {session.last_order_number}")

    sync_email_state(session)
    sync_payment_state(session)
    sync_facility_context(session)

    dialogue = getattr(session, "dialogue", None)
    if dialogue:
        topic = getattr(dialogue, "current_topic", "") or getattr(dialogue, "active_flow", "")
        if topic:
            state.current_topic = str(topic)


def build_composer_context(session: "SessionState") -> str:
    """Compact memory block for MainLLMComposer."""
    state = get_call_memory(session)
    parts: list[str] = []

    if state.rolling_summary:
        parts.append(f"[Earlier call summary: {state.rolling_summary}]")

    recent_users = state.user_turns[-_VERBATIM_TURNS:]
    recent_assistants = state.assistant_turns[-_VERBATIM_TURNS:]
    for i, ut in enumerate(recent_users):
        parts.append(f"[Turn user: {ut[:200]}]")
        if i < len(recent_assistants):
            parts.append(f"[Turn agent: {recent_assistants[i][:200]}]")

    if state.important_facts:
        parts.append("[Key facts: " + "; ".join(state.important_facts[-12:]) + "]")

    if state.isbns_provided:
        parts.append(f"[ISBNs remembered: {', '.join(state.isbns_provided[-10:])}]")

    if state.cart_facts:
        parts.append("[Cart: " + "; ".join(state.cart_facts[-5:]) + "]")

    if state.email_state != "none":
        parts.append(f"[Email state: {state.email_state}]")

    pfs = getattr(session, "payment_flow_status", "idle") or "idle"
    if pfs != "idle":
        parts.append(f"[Payment: {pfs}]")

    if state.facility_context:
        parts.append(f"[Facility: {state.facility_context}]")

    if state.current_topic:
        parts.append(f"[Topic: {state.current_topic}]")

    if state.customer_mood != "normal":
        parts.append(f"[Mood: {state.customer_mood}]")

    return "\n".join(parts)


def safe_history_append(session: "SessionState", role: str, content: str) -> None:
    """Append to session.history only for safe roles (no tool)."""
    if role in _FORBIDDEN_ROLES:
        return
    if "tool_calls" in (content or ""):
        return
    session.history.append({"role": role, "content": content})
