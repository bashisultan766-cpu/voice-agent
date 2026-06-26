"""v4.6 tests — deterministic email speller."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.email.speller import (
    build_email_readback,
    build_email_spell_only,
    normalize_email_for_customer_readback,
    speak_email,
    spell_email_for_voice,
)
from app.pipeline.router import detect
from app.dialogue.manager import DialogueManager
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="s-em", call_sid="CA_EM01",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


class TestEmailSpeller:
    def test_bashisultan_spelling(self):
        spelled = spell_email_for_voice("bashisultan766@gmail.com")
        assert "7-6-6" in spelled
        assert "gmail dot com" in spelled
        assert "B-A-S-H" in spelled

    def test_uppercase_normalizes(self):
        norm = normalize_email_for_customer_readback("BASHISULTAN766@gmail.com")
        assert norm == "bashisultan766@gmail.com"

    def test_activate_gmail_low_confidence(self):
        readback = build_email_readback("activate@gmail.com", "activate gmail")
        assert "wrong" in readback.lower() or "spell" in readback.lower()

    def test_spell_my_email_uses_formatter(self):
        s = _session(pending_email="bashisultan766@gmail.com")
        text = DialogueManager.build_spell_email_response(s)
        assert spell_email_for_voice("bashisultan766@gmail.com") in text

    def test_spell_this_after_email(self):
        s = _session(confirmed_email="bashisultan766@gmail.com")
        text = DialogueManager.build_spell_email_response(s)
        assert spell_email_for_voice("bashisultan766@gmail.com") in text

    def test_spell_email_request_not_product_search(self):
        r = detect("can you spell my email", session=_session())
        assert r.intent == "spell_email_request"

    def test_spell_it_email_context(self):
        s = _session(pending_email="test@gmail.com", payment_flow_status="awaiting_email_confirmation")
        r = detect("spell it", session=s)
        assert r.intent == "spell_email_request"

    def test_spell_it_not_author_search(self):
        r = detect("spell it", session=_session())
        assert r.intent != "author_search"
