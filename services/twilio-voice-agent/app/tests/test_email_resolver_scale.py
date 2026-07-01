"""Unified email resolver — scale tests for diverse spoken emails."""
from __future__ import annotations

from app.email.resolver import (
    fragment_capture_prompt,
    parse_letter_spelled_email,
    resolve_spoken_email_address,
)
from app.payment.payment_state_machine import process_payment_turn
from app.state.models import SessionState


def test_letter_spelled_email_with_double_letter():
    text = "B I l a l a, double b, a s I 0 3 4 1 at the rate gmail dot com."
    assert parse_letter_spelled_email(text) == "bilalabbasi0341@gmail.com"


def test_resolver_picks_best_clause_from_polluted_merge():
    polluted = (
        "@gmail.com. Bilal Basi. Hello? "
        "The email address is blal basi 2 0 4 at g mail dot com."
    )
    result = resolve_spoken_email_address(polluted)
    assert result.email == "blalbasi204@gmail.com"
    assert result.source in ("spoken", "letter_spelled", "typed")


def test_fragment_prompt_escalates():
    assert "continue" in fragment_capture_prompt(1).lower()
    assert "whole email" in fragment_capture_prompt(3).lower()
    assert "one sentence" in fragment_capture_prompt(5).lower()


def test_low_confidence_still_captures_with_full_spellback():
    session = SessionState(
        session_id="s",
        call_sid="CAtest1",
        from_number="+1",
        to_number="+2",
        cart_items=[{"title": "Book", "variant_id": "v1", "quantity": 1}],
        payment_flow_status="awaiting_email",
        awaiting_payment_email=True,
    )
    hint = process_payment_turn(
        session,
        "P b a s h i at gmail dot com.",
        turn_mode="email",
    )
    assert hint.email_captured is True
    assert hint.deliver_email_spell_readback
