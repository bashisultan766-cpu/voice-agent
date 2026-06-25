"""v4.7 — email spelling and deliverability."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.email.deliverability import (
    build_payment_email_plain,
    build_payment_email_subject,
    validate_payment_email_content,
)
from app.pipeline.email_speller import (
    build_email_readback,
    build_email_spell_only,
    speak_email,
    spell_email_for_voice,
)
from app.pipeline.router import detect
from app.state.models import SessionState

_EMAIL = "bashisultan766@gmail.com"


class TestEmailSpellingV47:
    def test_pending_email_exact_format(self):
        text = build_email_readback(_EMAIL)
        assert text.startswith(f"I heard {speak_email(_EMAIL)}.")
        assert spell_email_for_voice(_EMAIL) in text
        assert text.endswith("Is that correct?")

    def test_confirmed_email_exact_format(self):
        text = build_email_spell_only(_EMAIL)
        assert text.startswith(f"I have {speak_email(_EMAIL)}.")
        assert spell_email_for_voice(_EMAIL) in text

    def test_no_activate_wording(self):
        text = build_email_readback(_EMAIL)
        assert "activate" not in text.lower()

    def test_spell_in_email_context(self):
        s = SessionState(
            session_id="e", call_sid="CA_E",
            from_number="+1", to_number="+1",
            pending_email=_EMAIL,
            payment_flow_status="awaiting_email_confirmation",
        )
        r = detect("Letter by letter. Can you repeat?", s)
        assert r.intent == "spell_email_request"


class TestEmailDeliverability:
    def test_subject_safe(self):
        subject = build_payment_email_subject("SureShot Books")
        assert "SureShot Books" in subject
        assert "urgent" not in subject.lower()

    def test_one_payment_link(self):
        url = "https://checkout.example.com/pay/abc123"
        body = build_payment_email_plain(url)
        assert body.count(url) == 1

    def test_plain_and_html_validation(self):
        url = "https://checkout.example.com/pay/abc123"
        plain = build_payment_email_plain(url)
        from app.email.deliverability import build_payment_email_html
        html = build_payment_email_html(url)
        report = validate_payment_email_content(
            subject=build_payment_email_subject(),
            plain_body=plain,
            html_body=html,
            from_email="orders@sureshotbooks.com",
            checkout_url=url,
        )
        assert report.has_plain_text
        assert report.has_html
        assert report.body_safe
