"""v4.15.0 — Checkout certifier tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.payment.checkout_certifier import (
    contains_processing_fee,
    safe_message_for_failure,
    validate_checkout_payload,
)


def _session():
    from app.state.models import SessionState

    s = SessionState(session_id="s", call_sid="CA4150CO", from_number="", to_number="")
    s.confirmed_email = "test@example.com"
    s.cart_items = [{"variant_id": "v1", "quantity": 1, "title": "Book"}]
    return s


class TestCheckoutCertifier:
    def test_dry_run_validates_payload(self):
        items = [{"variant_id": "v1", "quantity": 1, "title": "Book", "price": "$10"}]
        result = validate_checkout_payload(items, session=_session(), confirmed_email="test@example.com")
        assert result.payload_valid
        assert result.success

    def test_invalid_variant_classified(self):
        items = [{"variant_id": "", "quantity": 1}]
        result = validate_checkout_payload(items)
        assert not result.payload_valid
        assert result.failure_class == "invalid_variant"
        assert "valid checkout option" in result.safe_message.lower()

    def test_shopify_failure_message(self):
        msg = safe_message_for_failure("shopify_api_error")
        assert "trouble creating" in msg.lower()

    def test_success_does_not_say_sent(self):
        result = validate_checkout_payload([{"variant_id": "v1", "quantity": 1}])
        assert "sent" not in result.safe_message.lower()
        assert "sending" in result.safe_message.lower() or "created" in result.safe_message.lower()

    def test_no_processing_fee(self):
        assert not contains_processing_fee("Your subtotal before shipping is $10.")
        assert contains_processing_fee("There is a processing fee of $2.")

    @pytest.mark.asyncio
    async def test_certify_checkout_dry_run(self):
        from app.payment.checkout_certifier import certify_checkout

        session = _session()
        result = await certify_checkout(
            session,
            [{"variant_id": "v1", "quantity": 1, "title": "Book", "price": "$10"}],
            group_id="g1",
        )
        assert result.success
        assert result.dry_run
        assert result.checkout_id.startswith("dry_run_")
