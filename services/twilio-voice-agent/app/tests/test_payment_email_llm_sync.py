"""Payment email confirmation when LLM read back email without FSM."""
from __future__ import annotations

from app.payment.payment_state_machine import (
    process_payment_turn,
    sync_llm_offered_email_from_history,
)
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="sess_sync",
        call_sid="CA_SYNC01",
        from_number="+15551234001",
        to_number="+15559994001",
        cart_items=[{"title": "Book", "variant_id": "v1", "quantity": 1}],
        payment_flow_status="idle",
    )
    base.update(kwargs)
    return SessionState(**base)


def test_sync_llm_offered_email_from_assistant_confirmation():
    session = _session()
    session.history = [
        {
            "role": "assistant",
            "content": (
                'Just to confirm, I heard "jessica at sureshotbooks dot com." '
                "Is that correct?"
            ),
        },
    ]
    assert sync_llm_offered_email_from_history(session) is True
    assert session.pending_payment_email == "jessica@sureshotbooks.com"
    assert session.awaiting_payment_email_confirmation is True


def test_yes_after_llm_confirmation_promotes_email():
    session = _session()
    session.history = [
        {
            "role": "assistant",
            "content": (
                'Just to confirm, I heard "mnubashirbusiness3 at gmail dot com." '
                "Is that correct?"
            ),
        },
    ]
    hint = process_payment_turn(session, "Yeah. That's correct.")
    assert hint.email_confirmed is True
    assert session.confirmed_email == "mnubashirbusiness3@gmail.com"
    assert session.payment_email_confirmed is True
