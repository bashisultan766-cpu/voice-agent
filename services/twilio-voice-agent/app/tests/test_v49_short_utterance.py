"""v4.9 — short utterance resolver tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.cart.candidate import save_product_candidate
from app.cart.session import get_ledger
from app.dialogue.manager import DialogueManager
from app.dialogue.short_utterance_resolver import resolve_short_utterance
from app.dialogue.states import DialogueState
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="su", call_sid="CA_SU01",
        from_number="+1", to_number="+1",
        **kwargs,
    )


class TestShortUtteranceResolver:
    def test_yes_after_product_add_to_cart(self):
        s = _session()
        st = DialogueState(active_flow="cart_building", expected_next="confirm_product")
        DialogueManager.set_state(s, st)
        save_product_candidate(
            s, title="Test Book", variant_id="gid://1", source_intent="isbn_search",
        )
        r = resolve_short_utterance("Yes.", s)
        assert r.resolved
        assert r.intent == "add_to_cart"

    def test_yes_after_email_confirmation(self):
        s = _session(
            pending_email="test@example.com",
            payment_flow_status="awaiting_email_confirmation",
        )
        r = resolve_short_utterance("Yes.", s)
        assert r.intent == "email_confirmation"

    def test_yes_payment_execute(self):
        s = _session(payment_flow_status="awaiting_send_confirmation")
        r = resolve_short_utterance("Yes.", s)
        assert r.intent == "payment_execute"

    def test_no_email_correction(self):
        s = _session(
            pending_email="test@example.com",
            payment_flow_status="awaiting_email_confirmation",
        )
        r = resolve_short_utterance("No.", s)
        assert r.intent == "email_correction"

    def test_too_cart_continuation(self):
        s = _session()
        st = DialogueState(active_flow="cart_building")
        DialogueManager.set_state(s, st)
        get_ledger(s)
        r = resolve_short_utterance("Too.", s)
        assert r.resolved
        assert r.intent == "add_to_cart"

    def test_okay_after_payment_not_cart(self):
        s = _session(payment_flow_status="payment_sent")
        s.payment_flow_result = {"email_sent": True}
        r = resolve_short_utterance("Okay.", s)
        assert r.intent == "ending_thanks"

    def test_okay_no_random_cart(self):
        s = _session()
        save_product_candidate(
            s, title="Book", variant_id="gid://1", source_intent="isbn_search",
        )
        st = DialogueState(active_flow="cart_building", expected_next="")
        DialogueManager.set_state(s, st)
        r = resolve_short_utterance("Okay.", s)
        assert not r.resolved or r.intent != "add_to_cart"
