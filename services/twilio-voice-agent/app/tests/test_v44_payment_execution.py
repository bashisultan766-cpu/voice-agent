"""
v4.4 tests — payment worker execution and PaymentFlowResult.
"""
from __future__ import annotations

import os
import pytest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.pipeline.compound_intent import detect, enhance_intent
from app.pipeline.router import IntentResult, detect as base_detect
from app.state.models import SessionState
from app.workers.base import WorkerResult
from app.workers.orchestrator import _INTENT_WORKERS, WorkerOrchestrator
from app.workers.payment_flow_worker import PaymentFlowWorker


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="s-v44", call_sid="CA_V44001",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


def _settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True)


def _cart(**extra):
    return [{
        "title": "Dune", "isbn": "9780441172719",
        "variant_id": "gid://shopify/Variant/1", "quantity": 1,
        "confirmation_status": "confirmed", **extra,
    }]


class TestPaymentIntentRouting:
    def test_send_payment_link_runs_payment_flow_worker(self):
        assert _INTENT_WORKERS["send_payment_link"] == ["payment_flow"]

    def test_send_payment_link_intent_detected(self):
        r = detect("Send me the payment link.")
        assert r.intent == "send_payment_link"

    def test_compound_payment_over_email(self):
        r = detect("Send payment link on bashisultan766@gmail.com.")
        assert r.intent == "send_payment_link"
        assert r.entities.get("email")

    def test_payment_status_question(self):
        r = detect("Did you send it?")
        assert r.intent == "payment_status_question"

    def test_spell_this_in_email_context(self):
        s = _session(pending_email="alice@example.com",
                       payment_flow_status="awaiting_email_confirmation")
        r = detect("Can you spell this?", s)
        assert r.intent == "spell_email_request"


class TestPaymentFlowWorker:
    async def test_missing_email_asks(self):
        session = _session()
        session.cart_items = _cart()
        worker = PaymentFlowWorker()
        r = await worker.run(session, {"intent": "send_payment_link"}, _settings())
        assert r.data["ran"] is True
        assert r.data["allowed"] is False
        assert "confirmed_email" in r.data["missing_fields"] or "email_confirmation" in r.data["missing_fields"]
        assert session.payment_flow_result.get("ran") is True

    async def test_pending_email_asks_confirmation(self):
        session = _session(pending_email="alice@example.com",
                           payment_flow_status="awaiting_email_confirmation")
        session.cart_items = _cart()
        worker = PaymentFlowWorker()
        r = await worker.run(session, {"intent": "send_payment_link"}, _settings())
        assert not r.success or r.data.get("stage") == "awaiting_email_confirmation"
        assert "confirm" in r.safe_summary.lower()

    async def test_ready_send_payment_link_executes(self):
        session = _session(
            confirmed_email="alice@example.com",
            payment_flow_status="awaiting_send_confirmation",
        )
        session.cart_items = _cart()
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
            r = await worker.run(session, {"intent": "send_payment_link"}, _settings())
        assert r.success
        assert r.data["email_sent"] is True
        assert session.payment_flow_status == "payment_sent"

    async def test_awaiting_send_yes_executes(self):
        session = _session(
            confirmed_email="alice@example.com",
            payment_flow_status="awaiting_send_confirmation",
        )
        session.cart_items = _cart()
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
            r = await worker.run(session, {"intent": "payment_execute"}, _settings())
        assert r.data["email_sent"] is True

    async def test_already_sent_no_duplicate(self):
        session = _session(
            confirmed_email="alice@example.com",
            payment_flow_status="payment_sent",
        )
        session.payment_email_sent_to = ["alice@example.com"]
        session.cart_items = _cart()
        worker = PaymentFlowWorker()
        r = await worker.run(session, {"intent": "send_payment_link"}, _settings())
        assert r.data["stage"] == "already_sent"

    async def test_orchestrator_runs_payment_flow_for_send(self):
        orch = WorkerOrchestrator()
        session = _session()
        session.cart_items = _cart()
        bundle = await orch.run(
            IntentResult(intent="send_payment_link", confidence=0.9, entities={"intent": "send_payment_link"}),
            session,
            _settings(),
        )
        assert "payment_flow" in bundle.results
        assert bundle.results["payment_flow"].data.get("ran") is True

    async def test_payment_status_not_sent_explains_missing(self):
        session = _session()
        worker = PaymentFlowWorker()
        r = await worker.run(session, {"intent": "payment_status_question"}, _settings())
        assert "haven't sent" in r.safe_summary.lower() or "have not sent" in r.safe_summary.lower()
