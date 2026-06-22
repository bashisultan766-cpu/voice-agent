"""v4.6 tests — naturalness v2."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.dialogue.naturalness import NaturalnessController
from app.state.models import SessionState


def _session() -> SessionState:
    return SessionState(
        session_id="s-n", call_sid="CA_N01",
        from_number="+15551234567", to_number="+18005551234",
    )


class TestNaturalnessV2:
    def test_repeated_phrase_prevention(self):
        s = _session()
        NaturalnessController.record_response(s, "Let me check that for you.")
        NaturalnessController.record_response(s, "Let me check again.")
        note = NaturalnessController.avoid_repetition_note(s)
        assert "let me check" in note.lower()

    def test_frustration_repair_one_apology(self):
        s = _session()
        s.isbn_history = ["978111"]
        from app.cart.candidate import save_product_candidate
        from app.cart.session import get_ledger
        from app.cart.session import confirm_last_candidate
        save_product_candidate(s, title="Book", isbn="978111", variant_id="gid://1")
        confirm_last_candidate(s)
        msg = NaturalnessController.frustration_repair_message(s)
        assert "sorry" in msg.lower()

    def test_not_over_apologizing(self):
        s = _session()
        NaturalnessController.record_response(s, "Sorry about that.")
        NaturalnessController.record_response(s, "Sorry again.")
        assert not NaturalnessController.should_include_apology(s)

    def test_already_gave_repair_style(self):
        s = _session()
        NaturalnessController.apply_frustration(s, "I already gave you the ISBN")
        hint = NaturalnessController.style_hint(s)
        assert "already gave" in hint.lower() or "repair" in NaturalnessController.get_state(s).style_mode

    def test_word_count_target(self):
        short = "Got it. What is the ISBN?"
        assert NaturalnessController.word_count_ok(short)
