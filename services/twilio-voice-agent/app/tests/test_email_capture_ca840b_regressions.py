"""Regression tests for live call CA840b email capture failures."""
from __future__ import annotations

from app.agent_runtime.commerce_flow_state import process_commerce_turn
from app.email.capture import extract_best_email_phrase, normalize_spoken_email
from app.payment.payment_state_machine import (
    capture_payment_email,
    extract_email_from_text,
    process_payment_turn,
)
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="sess_ca840b",
        call_sid="CA840bec",
        from_number="+15551234001",
        to_number="+15559994001",
        cart_items=[{"title": "An American Hustler", "variant_id": "v1", "quantity": 20}],
        payment_flow_status="awaiting_email",
        awaiting_payment_email=True,
    )
    base.update(kwargs)
    return SessionState(**base)


def test_spoken_email_with_trailing_period_parses():
    email = normalize_spoken_email("Bilal Abbasi 0 3 4 1 at g mail dot com.")
    assert email == "bilalabbasi0341@gmail.com"


def test_extract_best_email_phrase_from_polluted_buffer():
    polluted = (
        "@gmail.com. Bilal Basi. 0 3 4 1 activategmail.com. Hello? "
        "The email address is blal basi 2 0 4 at g mail dot com."
    )
    phrase = extract_best_email_phrase(polluted)
    assert "at g mail dot com" in phrase.lower()
    assert extract_email_from_text(polluted) == "blalbasi204@gmail.com"


def test_clean_email_turn_gets_full_confirmation_not_fragment_hint():
    session = _session()
    hint = process_payment_turn(
        session,
        "Bilal Abbasi 0 3 4 1 at g mail dot com.",
        turn_mode="email",
    )
    assert hint.email_captured is True
    assert hint.deliver_email_spell_readback
    assert "please continue" not in (hint.force_reply or "").lower()
    assert session.pending_payment_email == "bilalabbasi0341@gmail.com"


def test_email_frustration_repeats_pending_spelling():
    session = _session(
        pending_payment_email="bilalabbasi0341@gmail.com",
        awaiting_payment_email=False,
        awaiting_payment_email_confirmation=True,
        payment_flow_status="awaiting_email_confirmation",
    )
    hint = process_payment_turn(session, "I told you my email 5 times.")
    assert hint.deliver_email_spell_readback
    assert hint.skip_openai is True


def test_quantity_and_need_copies_adds_without_second_yes():
    session = _session(
        commerce_flow_status="awaiting_quantity",
        commerce_pending_candidate={
            "title": "#HealthyAdult",
            "variant_id": "v2",
            "price": "$10",
            "available": True,
        },
        cart_items=[],
        payment_flow_status="idle",
        awaiting_payment_email=False,
    )
    hint = process_commerce_turn(session, "Yes. I need 50 copy of this book.")
    assert hint.book_added is True
    assert "added" in (hint.force_reply or "").lower()
