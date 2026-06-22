"""
v4.3 tests — cart memory, multi-book, payment flow.
"""
from __future__ import annotations

import os
import pytest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.cart.ledger import CartItem, CartLedger
from app.cart.session import get_ledger, sync_ledger_to_session
from app.dialogue.manager import DialogueManager
from app.state.models import SessionState
from app.workers.payment_flow_worker import PaymentFlowWorker
from app.workers.response_plan_worker import ResponsePlanWorker
from app.workers.base import WorkerBundle, WorkerResult


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="s-v43c", call_sid="CA_V43C01",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


def _settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True)


class TestCartMemory:
    def test_three_isbns_two_found_one_not(self):
        ledger = CartLedger()
        for isbn in ("978111", "978222", "978333"):
            ledger.record_isbn_provided(isbn)
        ledger.add_candidate(CartItem(title="Book One", isbn="978111", variant_id="gid://1"))
        ledger.add_candidate(CartItem(title="Book Two", isbn="978222", variant_id="gid://2"))
        ledger.confirm_last_candidate()
        ledger.confirm_last_candidate()
        ledger.record_isbn_not_found("978333")
        session = _session()
        sync_ledger_to_session(session, ledger)
        summary = DialogueManager.build_memory_response(session, "titles_question")
        assert "Book One" in summary
        assert "978333" in summary or "not" in summary.lower()

    def test_isbn_count(self):
        session = _session()
        session.isbn_history = ["978111", "978222", "978333"]
        text = DialogueManager.build_memory_response(session, "isbn_count_question")
        assert "three" in text.lower() or "3" in text

    def test_another_book_keeps_first(self):
        ledger = CartLedger()
        ledger.add_candidate(CartItem(title="Dune", isbn="9780441172719"))
        ledger.confirm_last_candidate()
        ledger.add_candidate(CartItem(title="1984", isbn="9780451524935"))
        assert ledger.confirmed_count() == 1
        assert "Dune" in ledger.titles(confirmed_only=True)


class TestPaymentFlowWorker:
    async def test_missing_email_asks(self):
        session = _session()
        session.cart_items = [{
            "title": "Dune", "variant_id": "gid://1", "quantity": 1,
            "confirmation_status": "confirmed",
        }]
        worker = PaymentFlowWorker()
        r = await worker.run(session, {}, _settings())
        assert not r.success
        assert "email" in r.safe_summary.lower()

    async def test_full_flow_success(self):
        session = _session(
            confirmed_email="alice@example.com",
            payment_flow_status="awaiting_send_confirmation",
        )
        session.cart_items = [{
            "title": "Dune", "variant_id": "gid://shopify/Variant/1", "quantity": 1,
            "confirmation_status": "confirmed",
        }]
        mock_checkout = AsyncMock(return_value=WorkerResult(
            worker_name="checkout", success=True,
            data={"checkout_url": "https://pay.example/1"},
            source="shopify",
        ))
        mock_email = AsyncMock(return_value=WorkerResult(
            worker_name="payment_email", success=True,
            data={"sent": True}, source="resend",
        ))
        worker = PaymentFlowWorker()
        with patch("app.workers.payment_flow_worker.CheckoutWorker") as MockCo, \
             patch("app.workers.payment_flow_worker.PaymentEmailWorker") as MockEm:
            MockCo.return_value.run = mock_checkout
            MockEm.return_value.run = mock_email
            r = await worker.run(
                session,
                {"intent": "send_payment_link", "raw_text": "Send me the payment link."},
                _settings(),
            )
        assert r.success
        assert session.payment_flow_status == "payment_sent"


class TestResponsePlanV43:
    async def test_vague_book_plan(self):
        worker = ResponsePlanWorker()
        session = _session()
        r = await worker.run(session, {"intent": "vague_book_request"}, _settings())
        assert session.response_plan["action"] == "clarify_vague_book"
        assert "ISBN" in session.response_plan["say"]

    async def test_low_confidence_email(self):
        worker = ResponsePlanWorker()
        session = _session(
            pending_email="alice@example.com",
            payment_flow_status="awaiting_email_confirmation",
        )
        session.email_confidence = "low"
        r = await worker.run(session, {"intent": "email_provided"}, _settings())
        assert "spell" in session.response_plan["say"].lower()
