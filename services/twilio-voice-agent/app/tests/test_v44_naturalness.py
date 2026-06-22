"""v4.4 tests — naturalness, repetition, frustration handling."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")

from app.dialogue.naturalness import NaturalnessController
from app.state.models import SessionState


def _session() -> SessionState:
    return SessionState(
        session_id="s-nat", call_sid="CA_NAT01",
        from_number="+15551234567", to_number="+18005551234",
    )


class TestNaturalnessController:
    def test_repeated_let_me_check_tracked(self):
        s = _session()
        for _ in range(3):
            NaturalnessController.record_response(s, "Let me check that for you.")
        note = NaturalnessController.avoid_repetition_note(s)
        assert "let me check" in note.lower()

    def test_frustration_detected(self):
        assert NaturalnessController.detect_frustration("No no, that's wrong.")
        assert NaturalnessController.detect_frustration("I already told you my email.")
        assert not NaturalnessController.detect_frustration("Yes, that's correct.")

    def test_frustration_sets_style(self):
        s = _session()
        NaturalnessController.apply_frustration(s, "Why are you not listening?")
        assert NaturalnessController.get_state(s).style_mode == "frustrated_customer"

    def test_frustrated_style_hint(self):
        s = _session()
        NaturalnessController.set_style(s, "frustrated_customer")
        hint = NaturalnessController.style_hint(s)
        assert "apology" in hint.lower() or "frustrated" in hint.lower()

    def test_payment_mode_hint(self):
        s = _session()
        NaturalnessController.set_style(s, "payment_mode")
        assert "payment" in NaturalnessController.style_hint(s).lower()
