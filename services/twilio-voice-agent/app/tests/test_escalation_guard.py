"""EscalationGuard — break infinite workflow stage loops."""
from __future__ import annotations

import logging

import pytest

from app.agent_runtime.escalation_guard import (
    LOOP_TERMINAL_REPLY,
    MAX_STAGE_REPEATS,
    EscalationGuard,
    apply_forced_handoff,
    check_turn,
    infer_workflow_stage,
    reset,
)
from app.agent_runtime.workflow_contracts import (
    ORDER_WORKFLOW,
    PRODUCT_SEARCH_WORKFLOW,
    SUPPORT_HANDOFF_WORKFLOW,
)
from app.observability.workflow_events import STEP_ESCALATION_LOOP_DETECTED
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="s",
        call_sid="CA_GUARD",
        from_number="+1",
        to_number="+2",
        **kwargs,
    )


def test_infer_product_clarification_stage():
    session = _session()
    stage = infer_workflow_stage(
        session, PRODUCT_SEARCH_WORKFLOW, "hello there", turn_mode="",
    )
    assert stage == "clarification"


def test_loop_triggers_after_three_consecutive_clarifications(caplog: pytest.LogCaptureFixture):
    caplog.set_level(logging.INFO, logger="app.observability.workflow_events")
    session = _session()

    for i in range(MAX_STAGE_REPEATS):
        result = check_turn(session, PRODUCT_SEARCH_WORKFLOW, f"vague {i}", turn_mode="")
        assert not result.loop_detected

    result = check_turn(session, PRODUCT_SEARCH_WORKFLOW, "still vague", turn_mode="")
    assert result.loop_detected
    assert result.repeat_count == MAX_STAGE_REPEATS + 1
    assert session.awaiting_not_found_escalation_email is True
    assert any(STEP_ESCALATION_LOOP_DETECTED in r.message for r in caplog.records)


def test_support_loop_sets_terminal_flag():
    session = _session(
        awaiting_not_found_escalation_email=True,
        pending_not_found_escalation={"email_capture_mode": "silent"},
    )
    for _ in range(MAX_STAGE_REPEATS + 1):
        result = check_turn(session, SUPPORT_HANDOFF_WORKFLOW, "um", turn_mode="email")

    assert result.loop_detected
    assert session.escalation_loop_terminal is True
    assert LOOP_TERMINAL_REPLY in result.forced_reply


def test_order_loop_forces_handoff():
    session = _session(
        voice_conversation={
            "stage": "awaiting_order_number",
            "last_intent": "order_lookup",
            "last_order_id": None,
        },
    )
    result = None
    for _ in range(MAX_STAGE_REPEATS + 1):
        result = check_turn(session, ORDER_WORKFLOW, "I don't know", turn_mode="")

    assert result is not None
    assert result.loop_detected
    assert session.awaiting_not_found_escalation_email is True


def test_reset_clears_tracker():
    session = _session()
    check_turn(session, PRODUCT_SEARCH_WORKFLOW, "vague", turn_mode="")
    reset(session)
    assert session.workflow_stage_tracker["count"] == 0
    assert session.escalation_loop_terminal is False


def test_stage_change_resets_count():
    session = _session()
    check_turn(session, PRODUCT_SEARCH_WORKFLOW, "vague", turn_mode="")
    check_turn(session, PRODUCT_SEARCH_WORKFLOW, "vague again", turn_mode="")
    stage = infer_workflow_stage(
        session, PRODUCT_SEARCH_WORKFLOW, "9780747532699", turn_mode="isbn",
    )
    assert stage == "isbn_search"
    result = check_turn(
        session, PRODUCT_SEARCH_WORKFLOW, "9780747532699", turn_mode="isbn",
    )
    assert result.repeat_count == 1
    assert not result.loop_detected
