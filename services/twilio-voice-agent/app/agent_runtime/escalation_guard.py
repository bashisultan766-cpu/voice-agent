"""
EscalationGuard — detect and break infinite workflow stage loops.

Deterministic only: no LLM. When the same workflow stage repeats more than twice,
force support_handoff_workflow (or terminal handoff if already in support).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from .workflow_contracts import (
    CANONICAL_WORKFLOW_DOMAINS,
    ORDER_WORKFLOW,
    PRODUCT_SEARCH_WORKFLOW,
    SUPPORT_HANDOFF_WORKFLOW,
)

logger = logging.getLogger(__name__)

ESCALATION_GUARD_VERSION = "v1.0"
MAX_STAGE_REPEATS = 2  # trigger when count > MAX_STAGE_REPEATS (3rd consecutive hit)

LOOP_TERMINAL_REPLY = (
    "I've passed this along to our support team with what we have from this call. "
    "They'll follow up by email when they can."
)

STEP_ESCALATION_LOOP_DETECTED = "escalation_loop_detected"


@dataclass(frozen=True)
class EscalationGuardResult:
    loop_detected: bool
    domain: str
    stage: str
    repeat_count: int
    forced_reply: str = ""


def _tracker(session: Any) -> dict[str, Any]:
    raw = getattr(session, "workflow_stage_tracker", None)
    if not isinstance(raw, dict):
        raw = {"domain": "", "stage": "", "count": 0}
        session.workflow_stage_tracker = raw
    return raw


def infer_workflow_stage(
    session: Any,
    domain: str,
    caller_text: str,
    *,
    turn_mode: str = "",
) -> str:
    """Derive a stable stage key for loop detection — no LLM."""
    if getattr(session, "escalation_loop_terminal", False):
        return "loop_terminal"

    if domain == SUPPORT_HANDOFF_WORKFLOW:
        pending = dict(getattr(session, "pending_not_found_escalation", None) or {})
        contact = dict(pending.get("support_handoff_contact") or {})
        email = (contact.get("email") or pending.get("customer_email") or "").strip()
        name = (contact.get("name") or pending.get("customer_name") or "").strip()
        if not email:
            return "awaiting_email"
        if not name:
            return "awaiting_name"
        return "awaiting_finalize"

    if domain == PRODUCT_SEARCH_WORKFLOW:
        if dict(getattr(session, "product_search_fallback_pending", None) or {}):
            return "fallback_escalation"
        if getattr(session, "awaiting_not_found_escalation_email", False):
            return "handoff_staged"
        from .voice_workflows import has_structured_product_search_input, isbn_detected

        if not has_structured_product_search_input(session, caller_text, turn_mode):
            return "clarification"
        if isbn_detected(session, caller_text, turn_mode):
            buf = getattr(session, "pending_isbn_buffer", "") or ""
            if buf and len(buf) < 13:
                return "isbn_partial"
            return "isbn_search"
        return "title_search"

    if domain == ORDER_WORKFLOW:
        conv = getattr(session, "voice_conversation", None) or {}
        stage = str(conv.get("stage") or "idle")
        if stage == "awaiting_order_number":
            return "awaiting_order_number"
        if stage == "order_lookup":
            return "order_lookup"
        from .order_flow_state import extract_order_number, order_intent_detected

        if order_intent_detected(caller_text or "") and not extract_order_number(
            caller_text, session, turn_mode=turn_mode,
        ):
            return "awaiting_order_number"
        order_status = getattr(session, "order_flow_status", "idle") or "idle"
        if order_status != "idle":
            return f"order_{order_status}"
        return "order_idle"

    return "unknown"


def record_stage(
    session: Any,
    domain: str,
    stage: str,
) -> int:
    """Record consecutive stage visit; return current repeat count."""
    tracker = _tracker(session)
    if tracker.get("domain") == domain and tracker.get("stage") == stage:
        tracker["count"] = int(tracker.get("count") or 0) + 1
    else:
        tracker["domain"] = domain
        tracker["stage"] = stage
        tracker["count"] = 1
    return int(tracker["count"])


def check_turn(
    session: Any,
    domain: str,
    caller_text: str,
    *,
    turn_mode: str = "",
) -> EscalationGuardResult:
    """
    Infer stage, record repetition, and detect loops.

    When loop_detected is True, ``forced_reply`` is set — caller must return it
    and must not retry the stuck workflow stage.
    """
    if domain not in CANONICAL_WORKFLOW_DOMAINS:
        return EscalationGuardResult(
            loop_detected=False,
            domain=domain,
            stage="",
            repeat_count=0,
        )

    stage = infer_workflow_stage(session, domain, caller_text, turn_mode=turn_mode)
    count = record_stage(session, domain, stage)

    if count <= MAX_STAGE_REPEATS:
        return EscalationGuardResult(
            loop_detected=False,
            domain=domain,
            stage=stage,
            repeat_count=count,
        )

    reply = apply_forced_handoff(
        session,
        domain=domain,
        stage=stage,
        caller_text=caller_text,
    )
    logger.warning(
        "escalation_loop_detected sid=%s domain=%s stage=%s count=%d",
        (getattr(session, "call_sid", "") or "")[:6],
        domain,
        stage,
        count,
    )
    return EscalationGuardResult(
        loop_detected=True,
        domain=domain,
        stage=stage,
        repeat_count=count,
        forced_reply=reply,
    )


def _emit_loop_event(
    session: Any,
    *,
    domain: str,
    stage: str,
    repeat_count: int,
) -> None:
    from ..observability.workflow_events import STEP_ESCALATION_LOOP_DETECTED, emit_event

    domain_label = "support"
    if domain == PRODUCT_SEARCH_WORKFLOW:
        domain_label = "product_search"
    elif domain == ORDER_WORKFLOW:
        domain_label = "order"

    emit_event(
        {
            "event_type": "workflow_transition",
            "domain": domain_label,
            "step": STEP_ESCALATION_LOOP_DETECTED,
            "input_type": "fallback",
            "outcome": "escalate",
            "metadata": {
                "workflow_domain": domain,
                "stage": stage,
                "repeat_count": repeat_count,
            },
        },
        session=session,
    )


def apply_forced_handoff(
    session: Any,
    *,
    domain: str,
    stage: str,
    caller_text: str,
) -> str:
    """
    Force support handoff and stop retries — deterministic, no LLM.
    """
    from .not_found_escalation_flow import (
        PRODUCT_SEARCH_FALLBACK_HANDOFF_PROMPT,
        clear_product_search_fallback,
        support_handoff_preparation,
    )

    tracker = _tracker(session)
    repeat_count = int(tracker.get("count") or 0)
    _emit_loop_event(
        session,
        domain=domain,
        stage=stage,
        repeat_count=repeat_count,
    )

    clear_product_search_fallback(session)
    session.product_search_fallback_pending = {}

    if domain == SUPPORT_HANDOFF_WORKFLOW:
        session.escalation_loop_terminal = True
        return LOOP_TERMINAL_REPLY

    pending = dict(getattr(session, "pending_not_found_escalation", None) or {})
    query = (
        (pending.get("query") or pending.get("requested_value") or "")
        or (caller_text or "")[:80]
    ).strip()

    return support_handoff_preparation(
        session,
        user_text=caller_text,
        query=query,
        reason="escalation_loop",
        search_result={"count": 0, "escalation_loop": True, "stage": stage},
        handoff_prompt=PRODUCT_SEARCH_FALLBACK_HANDOFF_PROMPT,
    )


def reset(session: Any) -> None:
    """Clear guard state after successful resolution."""
    session.workflow_stage_tracker = {"domain": "", "stage": "", "count": 0}
    session.escalation_loop_terminal = False


class EscalationGuard:
    """Namespace for escalation loop detection — deterministic, no LLM."""

    MAX_STAGE_REPEATS = MAX_STAGE_REPEATS
    LOOP_TERMINAL_REPLY = LOOP_TERMINAL_REPLY
    STEP_ESCALATION_LOOP_DETECTED = STEP_ESCALATION_LOOP_DETECTED

    infer_workflow_stage = staticmethod(infer_workflow_stage)
    record_stage = staticmethod(record_stage)
    check_turn = staticmethod(check_turn)
    apply_forced_handoff = staticmethod(apply_forced_handoff)
    reset = staticmethod(reset)
