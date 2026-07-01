"""Standardized EMAIL_CAPTURE_MODE — spell readback, session cleanup, support handoff."""
from __future__ import annotations

import pytest

from app.agent_runtime.not_found_escalation_flow import process_not_found_escalation_turn
from app.email.speller import build_email_readback_parts
from app.payment.email_state import (
    EMAIL_CAPTURE_MODE,
    clear_email_capture_on_session_end,
    email_capture_mode_active,
    enter_email_capture_mode,
)
from app.payment.payment_state_machine import capture_payment_email
from app.state.models import SessionState


def test_enter_email_capture_mode():
    session = SessionState(
        session_id="s",
        call_sid="CA1",
        from_number="+1",
        to_number="+2",
    )
    enter_email_capture_mode(session)
    assert email_capture_mode_active(session)
    assert session.email_capture_mode == EMAIL_CAPTURE_MODE


def test_readback_standard_format():
    parts = build_email_readback_parts("buyer@yahoo.com")
    assert parts[0] == "I have buyer at yahoo dot com."
    assert parts[1] == "I will spell it for confirmation."
    assert any("B-U-Y" in p or "B-U-Y-E" in p for p in parts)
    assert parts[-1] == "Is that correct?"


def test_capture_sets_spell_readback_flag():
    session = SessionState(
        session_id="s",
        call_sid="CA1",
        from_number="+1",
        to_number="+2",
        cart_items=[{"title": "Book", "variant_id": "v1", "quantity": 1}],
        payment_flow_status="awaiting_email",
        awaiting_payment_email=True,
    )
    hint = capture_payment_email(session, "buyer@yahoo.com")
    assert hint.deliver_email_spell_readback
    assert email_capture_mode_active(session)


def test_clear_email_on_session_end():
    session = SessionState(
        session_id="s",
        call_sid="CA1",
        from_number="+1",
        to_number="+2",
        email_capture_mode=EMAIL_CAPTURE_MODE,
        pending_payment_email="a@b.com",
        confirmed_email="a@b.com",
        awaiting_not_found_escalation_email=True,
        pending_not_found_escalation={"staging_email": "a@b.com"},
    )
    clear_email_capture_on_session_end(session)
    assert not email_capture_mode_active(session)
    assert not session.pending_payment_email
    assert not session.confirmed_email
    assert not session.awaiting_not_found_escalation_email
    assert session.pending_not_found_escalation == {}


@pytest.mark.asyncio
async def test_support_handoff_standard_mode_spell_readback():
    session = SessionState(
        session_id="s",
        call_sid="CA1",
        from_number="+1",
        to_number="+2",
        awaiting_not_found_escalation_email=True,
        pending_not_found_escalation={
            "session_id": "s",
            "call_sid": "CA1",
            "query_type": "title",
            "issue_title": "Not found",
            "issue_detail": "No match.",
            "customer_name": "Han",
            "email_capture_mode": "standard",
        },
    )
    hint = await process_not_found_escalation_turn(
        session,
        "bashi 6 4 at g mail dot com",
    )
    assert hint.deliver_email_spell_readback
    assert session.pending_not_found_escalation.get("staging_email") == "bashi64@gmail.com"
    assert session.pending_not_found_escalation.get("awaiting_email_confirmation") is True
    assert email_capture_mode_active(session)
