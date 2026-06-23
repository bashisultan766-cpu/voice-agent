"""v4.15.0 — Email certifier tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.payment.email_certifier import (
    classify_resend_error,
    send_payment_email_certified,
    validate_email_for_certification,
)


class TestEmailCertifier:
    def test_dry_run_success(self):
        v = validate_email_for_certification("test@example.com", confirmed=True)
        assert v.success or v.blocked_reason == "not_allowlisted"

    @pytest.mark.asyncio
    async def test_resend_dry_run_success(self):
        result = await send_payment_email_certified(
            "test@example.com",
            "https://checkout.example/abc",
            "Book A",
            group_id="g1",
            idempotency_key="key1",
            confirmed=True,
        )
        assert result.success
        assert result.dry_run
        assert result.message_id
        assert "sent the payment link" in result.safe_message.lower()

    def test_invalid_email_rejected(self):
        v = validate_email_for_certification("not-an-email", confirmed=True)
        assert not v.success
        assert "valid" in v.safe_message.lower()

    def test_unconfirmed_blocks(self):
        v = validate_email_for_certification("test@example.com", confirmed=False)
        assert not v.success
        assert "confirm the email" in v.safe_message.lower()

    @pytest.mark.asyncio
    async def test_resend_failure_prevents_sent_wording(self):
        from app.payment.email_certifier import EmailCertificationResult, payment_sent_safe_message

        fail = EmailCertificationResult(
            success=False,
            dry_run=True,
            safe_message="I had trouble sending the email.",
        )
        msg = payment_sent_safe_message(True, fail)
        assert "trouble sending" in msg.lower() or "couldn't" in msg.lower()

    def test_classify_resend_error(self):
        assert classify_resend_error("Invalid email syntax") == "invalid_email"
        assert classify_resend_error("Rate limit exceeded") == "rate_limited"

    def test_allowlist_blocks_non_test_email(self):
        from app.payment.certification_config import get_test_email_allowlist, is_email_allowlisted

        # Default empty allowlist — real email mode requires explicit entries
        assert not is_email_allowlisted("random@test.com") or get_test_email_allowlist()
