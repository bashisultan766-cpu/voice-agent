"""Commerce/cart/payment/email stability layers — order-flow pattern parity."""
from __future__ import annotations

from app.agent_runtime.commerce_flow_state import (
    STATUS_AWAITING_QUANTITY,
    record_commerce_voice_reply,
    stage_product_candidate,
    try_commerce_brain_gate,
    try_commerce_hold_reply,
    try_commerce_repeat_reply,
)
from app.agent_runtime.payment_flow_state import (
    record_payment_voice_reply,
    try_payment_brain_gate,
    try_payment_hold_reply,
    try_payment_repeat_reply,
)
from app.runtime.fast_classifier import _commerce_payment_fsm_active, classify
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="stab",
        call_sid="CAstab123",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


def test_commerce_hold_during_quantity_step():
    session = _session(commerce_flow_status=STATUS_AWAITING_QUANTITY)
    stage_product_candidate(session, {
        "title": "Atomic Habits",
        "variant_id": "v1",
        "price": "$12",
        "available": True,
    })
    reply = try_commerce_hold_reply(session, "Just hold on a second.")
    assert reply
    assert "how many copies" in reply.lower()


def test_commerce_repeat_replays_cached_prompt():
    session = _session(
        commerce_flow_status=STATUS_AWAITING_QUANTITY,
        commerce_last_voice_reply="How many copies would you like?",
    )
    stage_product_candidate(session, {
        "title": "Atomic Habits",
        "variant_id": "v1",
        "price": "$12",
        "available": True,
    })
    reply = try_commerce_repeat_reply(session, "Can you repeat that?")
    assert reply == "How many copies would you like?"


def test_commerce_brain_gate_blocks_llm_on_repeat():
    session = _session(
        commerce_flow_status=STATUS_AWAITING_QUANTITY,
        commerce_last_voice_reply="Found it — Atomic Habits. How many copies?",
    )
    stage_product_candidate(session, {
        "title": "Atomic Habits",
        "variant_id": "v1",
        "price": "$12",
        "available": True,
    })
    gated = try_commerce_brain_gate(session, "What did you say?")
    assert gated == "Found it — Atomic Habits. How many copies?"


def test_payment_hold_during_email_collection():
    session = _session(
        awaiting_payment_email=True,
        payment_flow_status="awaiting_email",
    )
    reply = try_payment_hold_reply(session, "Wait one moment.")
    assert reply
    assert "email" in reply.lower()


def test_payment_repeat_replays_confirmation():
    session = _session(
        awaiting_payment_email_confirmation=True,
        payment_last_voice_reply="Just to confirm, I heard john at gmail dot com.",
        pending_payment_email="john@gmail.com",
    )
    reply = try_payment_repeat_reply(session, "Spell it again.")
    assert reply == "Just to confirm, I heard john at gmail dot com."


def test_payment_brain_gate_replays_email_prompt():
    session = _session(
        awaiting_payment_email_confirmation=True,
        payment_last_voice_reply="Just to confirm, I heard john at gmail dot com.",
        pending_payment_email="john@gmail.com",
    )
    gated = try_payment_brain_gate(session, "Say that again.")
    assert gated == "Just to confirm, I heard john at gmail dot com."


def test_record_voice_reply_helpers():
    session = _session()
    record_commerce_voice_reply(session, "How many copies?")
    assert session.commerce_last_voice_reply == "How many copies?"
    record_payment_voice_reply(session, "What email should I use?")
    assert session.payment_last_voice_reply == "What email should I use?"


def test_classifier_keeps_commerce_fsm_on_filler():
    session = _session(
        commerce_flow_status=STATUS_AWAITING_QUANTITY,
        commerce_pending_candidate={"variant_id": "v1", "title": "Book"},
    )
    assert _commerce_payment_fsm_active(session)
    result = classify("um", session)
    assert result.reason == "commerce_payment_fsm_active"
