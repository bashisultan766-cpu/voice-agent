"""v4.15.0 — Payment idempotency tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.payment.payment_idempotency import (
    check_idempotency,
    clear_idempotency_store,
    compute_idempotency_key,
    create_idempotency_record,
    mark_emailed,
    mark_failed,
)


def _key(**kwargs):
    defaults = dict(
        call_sid="CA4150",
        group_id="g1",
        items=[{"variant_id": "v1", "quantity": 1}],
        confirmed_email="a@test.com",
    )
    defaults.update(kwargs)
    return compute_idempotency_key(**defaults)


class TestPaymentIdempotency:
    def setup_method(self):
        clear_idempotency_store()

    def test_duplicate_blocked_while_pending(self):
        key = _key()
        create_idempotency_record(key, call_sid="CA4150", group_id="g1", items=[{"variant_id": "v1", "quantity": 1}], confirmed_email="a@test.com")
        result = check_idempotency(key)
        assert not result.allowed
        assert result.action == "block_pending"
        assert "already preparing" in result.message.lower()

    def test_duplicate_blocked_after_success(self):
        key = _key()
        create_idempotency_record(key, call_sid="CA4150", group_id="g1", items=[{"variant_id": "v1", "quantity": 1}], confirmed_email="a@test.com")
        mark_emailed(key, resend_message_id="msg123")
        result = check_idempotency(key)
        assert not result.allowed
        assert result.action == "block_emailed"
        assert "already sent" in result.message.lower()

    def test_retry_allowed_after_failure(self):
        key = _key()
        create_idempotency_record(key, call_sid="CA4150", group_id="g1", items=[{"variant_id": "v1", "quantity": 1}], confirmed_email="a@test.com")
        mark_failed(key)
        result = check_idempotency(key)
        assert result.allowed
        assert result.action == "allow_retry"

    def test_changed_email_new_key(self):
        k1 = _key(confirmed_email="a@test.com")
        k2 = _key(confirmed_email="b@test.com")
        assert k1 != k2

    def test_changed_cart_new_key(self):
        k1 = _key(items=[{"variant_id": "v1", "quantity": 1}])
        k2 = _key(items=[{"variant_id": "v2", "quantity": 1}])
        assert k1 != k2
