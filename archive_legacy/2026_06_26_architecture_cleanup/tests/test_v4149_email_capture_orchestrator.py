"""v4.14.9 — Email capture orchestrator tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.email_capture_orchestrator import (
    confirm_email,
    email_blocks_payment,
    handle_email_capture_turn,
    normalize_spoken_email,
    validate_email_syntax,
)


class TestEmailCaptureOrchestrator:
    def test_gmail_spoken_normalizes(self):
        result = normalize_spoken_email("bashi sultan 766 at gmail dot com")
        assert result.syntax_valid
        assert result.email and "gmail.com" in result.email

    def test_custom_domain_normalizes(self):
        result = normalize_spoken_email("orders at mail call communication dot com")
        assert result.syntax_valid
        assert result.email and "mailcallcommunication" in result.email

    def test_john_dot_smith_domain(self):
        result = normalize_spoken_email("john dot smith at company dot org")
        assert result.syntax_valid
        assert "company.org" in (result.email or "")

    def test_invalid_email_rejected(self):
        result = normalize_spoken_email("not an email address")
        assert not result.syntax_valid
        assert result.email is None

    def test_unconfirmed_blocks_payment(self):
        result = normalize_spoken_email("test at gmail dot com")
        block = email_blocks_payment(result)
        assert block and "confirm the email" in block.lower()

    def test_confirmed_allows_payment(self):
        parsed = normalize_spoken_email("test at gmail dot com")
        if parsed.email:
            confirmed = confirm_email(parsed.email, confirmed=True)
            assert confirmed.customer_confirmed
            assert email_blocks_payment(confirmed) is None

    def test_spellback_turn_flow(self):
        turn = handle_email_capture_turn("orders at company dot com")
        assert turn["action"] == "email_spellback_required"
        assert "heard" in turn["message"].lower() or "mean" in turn["message"].lower()

    def test_confirmation_yes(self):
        turn = handle_email_capture_turn(
            "yes",
            pending_email="orders@company.com",
            awaiting_confirmation=True,
        )
        assert turn["action"] == "email_confirmed"

    def test_validate_syntax(self):
        assert validate_email_syntax("valid@example.com")
        assert not validate_email_syntax("invalid")

    def test_no_verified_unless_confirmed(self):
        parsed = normalize_spoken_email("user at gmail dot com")
        assert not parsed.customer_confirmed
        block = email_blocks_payment(parsed)
        assert "confirm" in (block or "").lower()
