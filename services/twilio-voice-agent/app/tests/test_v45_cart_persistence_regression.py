"""
v4.5 live-call regression tests (from v4.4 production logs).
"""
from __future__ import annotations

import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.pipeline.compound_intent import detect
from app.pipeline.engine import _apply_email_state
from app.pipeline.router import IntentResult
from app.cart.candidate import save_product_candidate
from app.cart.session import get_ledger
from app.state.models import SessionState
from app.workers.orchestrator import WorkerOrchestrator
from app.workers.base import WorkerResult


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="live-v45", call_sid="CA_LIVEV45",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


def _settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True, VOICE_FILLER_AFTER_MS=0, VOICE_TOOL_TIMEOUT_MS=2500)


def _mock_isbn_product(isbn: str, title: str, variant: str):
    p = MagicMock(
        title=title, author="", price="12.99", available=True,
        variant_id=variant, product_id=f"gid://p/{isbn}",
    )
    return p


class TestV45LiveCallRegression:
    def test_01_vague_book_no_shopify(self):
        r = detect("Okay. I need a book.")
        assert r.intent == "vague_book_request"
        assert "product_phrase" not in r.entities

    async def test_02_isbn_saves_candidate(self):
        session = _session()
        orch = WorkerOrchestrator()
        isbn = "97898998627002"
        with patch("app.sync.repositories.ProductCache") as MockCache:
            MockCache.return_value.get_by_isbn = AsyncMock(
                return_value=_mock_isbn_product(isbn, "Book A", "gid://a"),
            )
            ir = IntentResult(
                intent="isbn_search", confidence=0.95,
                entities={"isbn": isbn, "intent": "isbn_search", "raw_text": "ISBN"},
            )
            await orch.run(ir, session, _settings())
        assert get_ledger(session).candidate_item is not None
        assert isbn in session.isbn_history or isbn[-10:] in str(session.isbn_history)

    async def test_03_yes_confirms_cart(self):
        session = _session()
        save_product_candidate(
            session, title="Book A", isbn="97898998627002", variant_id="gid://a",
        )
        session.dialogue.active_flow = "cart_building"
        ir = IntentResult(
            intent="add_to_cart", confidence=0.92,
            entities={"intent": "add_to_cart", "raw_text": "Yes."},
        )
        orch = WorkerOrchestrator()
        bundle = await orch.run(ir, session, _settings())
        assert "cart_mutation" in bundle.results
        assert get_ledger(session).confirmed_count() == 1

    async def test_07_three_books_confirm(self):
        session = _session()
        for i, isbn in enumerate(("97898998627002", "97898993861807", "9781962022064")):
            save_product_candidate(
                session, title=f"Book {i}", isbn=isbn, variant_id=f"gid://{i}",
            )
        r = detect("I need these 3 books.", session)
        assert r.intent == "add_to_cart"
        orch = WorkerOrchestrator()
        ir = IntentResult(
            intent=r.intent, confidence=r.confidence,
            entities={**r.entities, "intent": r.intent},
        )
        await orch.run(ir, session, _settings())
        assert get_ledger(session).confirmed_count() == 3

    async def test_08_payment_cart_count_not_zero(self):
        session = _session()
        for i, isbn in enumerate(("97898998627002", "97898993861807", "9781962022064")):
            save_product_candidate(
                session, title=f"Book {i}", isbn=isbn, variant_id=f"gid://{i}",
            )
            get_ledger(session).confirm_last_candidate()
        ir = IntentResult(
            intent="send_payment_link", confidence=0.9,
            entities={
                "intent": "send_payment_link",
                "raw_text": "Can you send me the 3 books payment link on my email?",
                "requested_cart_count": "3",
            },
        )
        orch = WorkerOrchestrator()
        bundle = await orch.run(ir, session, _settings())
        pf = bundle.results.get("payment_flow")
        assert pf is not None
        data = pf.data or {}
        assert data.get("cart_count", 0) == 3
        missing = data.get("missing_fields") or []
        assert "cart_items" not in missing

    def test_09_email_pending(self):
        r = detect("BashiSultan766@gmail.com.")
        assert r.intent == "email_provided"
        session = _session()
        _apply_email_state(session, r)
        assert session.pending_email

    def test_10_email_confirmed(self):
        session = _session(pending_email="bashisultan766@gmail.com",
                           payment_flow_status="awaiting_email_confirmation")
        ir = IntentResult(intent="email_confirmation", confidence=0.95, entities={})
        _apply_email_state(session, ir)
        assert session.confirmed_email == "bashisultan766@gmail.com"

    async def test_11_payment_allowed_with_cart(self):
        session = _session(
            confirmed_email="bashisultan766@gmail.com",
            payment_flow_status="awaiting_send_confirmation",
        )
        session.cart_items = [{
            "title": "Book", "variant_id": "gid://1", "quantity": 1,
            "confirmation_status": "confirmed", "isbn": "978111",
        }]
        mock_checkout = AsyncMock(return_value=WorkerResult(
            worker_name="checkout", success=True,
            data={"checkout_url": "https://pay.example/1"}, source="shopify",
        ))
        mock_email = AsyncMock(return_value=WorkerResult(
            worker_name="payment_email", success=True,
            data={"sent": True}, source="resend",
        ))
        ir = IntentResult(
            intent="send_payment_link", confidence=0.95,
            entities={"intent": "send_payment_link", "raw_text": "Yes. Sure. Send the payment link."},
        )
        with patch("app.workers.payment_flow_worker.CheckoutWorker") as MockCo, \
             patch("app.workers.payment_flow_worker.PaymentEmailWorker") as MockEm:
            MockCo.return_value.run = mock_checkout
            MockEm.return_value.run = mock_email
            orch = WorkerOrchestrator()
            bundle = await orch.run(ir, session, _settings())
        pf = bundle.results["payment_flow"]
        assert pf.data.get("cart_count", 0) > 0
        assert "cart_items" not in (pf.data.get("missing_fields") or [])

    async def test_add_to_cart_worker_always_runs(self):
        session = _session()
        save_product_candidate(
            session, title="X", isbn="978111", variant_id="gid://1",
        )
        ir = IntentResult(
            intent="add_to_cart", confidence=0.9,
            entities={"intent": "add_to_cart"},
        )
        bundle = await WorkerOrchestrator().run(ir, session, _settings())
        assert "cart_mutation" in bundle.workers_ran
        cm = bundle.results["cart_mutation"]
        assert cm.latency_ms >= 0
