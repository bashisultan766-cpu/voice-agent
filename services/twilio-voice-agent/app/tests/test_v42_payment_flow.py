"""
v4.2 tests — Deterministic payment flow (PaymentSafetyWorker + state machine).

Verifies:
- Payment blocked without confirmed email.
- Payment blocked without a book.
- Payment allowed when all fields confirmed.
- Already-sent state returns correct action.
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.state.models import SessionState
from app.workers.payment_safety_worker import PaymentSafetyWorker


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="s-pay", call_sid="CA_PAY01",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


def _settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True)


class TestPaymentSafetyWorker:
    async def test_blocked_without_book_or_email(self):
        worker = PaymentSafetyWorker()
        session = _session()
        r = await worker.run(session, {}, _settings())
        assert not r.success
        assert r.error_code == "missing_fields"
        assert "book" in r.data["missing"]
        assert "confirmed_email" in r.data["missing"]

    async def test_blocked_without_email(self):
        worker = PaymentSafetyWorker()
        session = _session(last_product_title="Dune")
        r = await worker.run(session, {}, _settings())
        assert not r.success
        assert "confirmed_email" in r.data["missing"]
        assert "book" not in r.data["missing"]

    async def test_blocked_without_book(self):
        worker = PaymentSafetyWorker()
        session = _session(confirmed_email="alice@example.com")
        r = await worker.run(session, {}, _settings())
        assert not r.success
        assert "book" in r.data["missing"]

    async def test_allowed_with_all_fields(self):
        worker = PaymentSafetyWorker()
        session = _session(
            last_product_title="Dune",
            confirmed_email="alice@example.com",
        )
        r = await worker.run(session, {}, _settings())
        assert r.success
        assert r.data["status"] == "ready"

    async def test_already_sent_returns_correct_action(self):
        worker = PaymentSafetyWorker()
        session = _session(
            last_product_title="Dune",
            confirmed_email="alice@example.com",
            payment_flow_status="payment_sent",
        )
        r = await worker.run(session, {}, _settings())
        assert r.success
        assert r.data["status"] == "already_sent"

    async def test_cart_items_count_as_book(self):
        worker = PaymentSafetyWorker()
        session = _session(confirmed_email="alice@example.com")
        session.cart_items = [{"title": "Dune", "confirmation_status": "confirmed"}]
        r = await worker.run(session, {}, _settings())
        assert r.success
        assert r.data["status"] == "ready"


class TestPaymentEmailStateMachine:
    def test_email_provided_sets_pending(self):
        """email_provided intent should set pending_email and advance to awaiting_confirmation."""
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult

        session = _session()
        ir = IntentResult(
            intent="email_provided",
            confidence=0.9,
            entities={"email": "alice@example.com"},
            needs_filler=False,
            suggested_tools=[],
        )
        _apply_email_state(session, ir)
        assert session.pending_email == "alice@example.com"
        assert session.payment_flow_status == "awaiting_email_confirmation"

    def test_email_confirmation_promotes_pending(self):
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult

        session = _session(pending_email="alice@example.com",
                           payment_flow_status="awaiting_email_confirmation")
        ir = IntentResult(
            intent="email_confirmation",
            confidence=0.95,
            entities={},
            needs_filler=False,
            suggested_tools=[],
        )
        _apply_email_state(session, ir)
        assert session.confirmed_email == "alice@example.com"
        assert session.pending_email == ""
        assert session.payment_flow_status == "awaiting_send_confirmation"

    def test_email_correction_clears_pending(self):
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult

        session = _session(pending_email="wrong@example.com",
                           payment_flow_status="awaiting_email_confirmation")
        ir = IntentResult(
            intent="email_correction",
            confidence=0.9,
            entities={},
            needs_filler=False,
            suggested_tools=[],
        )
        _apply_email_state(session, ir)
        assert session.pending_email == ""
        assert "wrong@example.com" in session.rejected_email_candidates
