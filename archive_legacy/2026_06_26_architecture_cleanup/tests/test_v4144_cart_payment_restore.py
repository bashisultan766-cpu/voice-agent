"""v4.14.4 — Cart and payment flow restore in MainLLMAgent mode."""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")
os.environ.setdefault("VOICE_AGENT_RUNTIME_MODE", "main_llm_agent")


@pytest.fixture
def settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True, VOICE_AGENT_RUNTIME_MODE="main_llm_agent")


def _session():
    from app.state.models import SessionState
    return SessionState(
        session_id="sess4144cart",
        call_sid="CA4144CART",
        from_number="+15551234567",
        to_number="+15559876543",
    )


class TestCartPaymentRestore:
    @pytest.mark.asyncio
    async def test_isbn_search_product_found(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="ISBN is 9780441172719", settings=settings,
        )
        assert decision["response_mode"] == "needs_tools"
        assert "isbn_lookup" in decision["tool_categories"]

    @pytest.mark.asyncio
    async def test_add_it_maps_cart_mutation(self, settings):
        from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents
        from app.agent_runtime.tool_entity_extractor import extract_tool_entities

        entities = extract_tool_entities("add it")
        decision = {"tool_categories": ["cart_mutation"], "intent": "add_to_cart"}
        plans = map_tool_categories_to_worker_intents(decision, entities)
        assert plans[0].worker_intent == "add_to_cart"

    @pytest.mark.asyncio
    async def test_cart_count_memory(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        session = _session()
        from app.cart.ledger import CartItem, CartLedger
        from app.cart.session import sync_ledger_to_session

        ledger = CartLedger()
        ledger.add_candidate(CartItem(title="Dune", variant_id="gid://1"))
        ledger.confirm_last_candidate()
        ledger.add_candidate(CartItem(title="1984", variant_id="gid://2"))
        ledger.confirm_last_candidate()
        sync_ledger_to_session(session, ledger)

        decision = await decide_and_answer(
            user_turn="How many books are in my cart?",
            session=session,
            settings=settings,
        )
        assert decision["response_mode"] == "needs_tools" or decision["intent"] in (
            "cart_count_question", "memory_summary_question",
        )

    @pytest.mark.asyncio
    async def test_payment_link_happy_path_mocked(self, settings):
        from app.workers.payment_flow_worker import PaymentFlowWorker
        from app.workers.base import WorkerResult

        session = _session()
        session.confirmed_email = "alice@example.com"
        session.payment_flow_status = "awaiting_send_confirmation"
        session.cart_items = [{
            "title": "Dune",
            "variant_id": "gid://shopify/Variant/1",
            "quantity": 1,
            "confirmation_status": "confirmed",
        }]

        mock_checkout = AsyncMock(return_value=WorkerResult(
            worker_name="checkout", success=True,
            data={"checkout_url": "https://pay.example/1"}, source="shopify",
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
                {"intent": "send_payment_link", "raw_text": "Send payment link"},
                settings,
            )
        assert r.success
        assert session.payment_flow_status == "payment_sent"
        assert "processing fee" not in (r.safe_summary or "").lower()

    @pytest.mark.asyncio
    async def test_payment_safety_blocks_empty_cart(self, settings):
        from app.workers.payment_flow_worker import PaymentFlowWorker

        session = _session()
        session.confirmed_email = "alice@example.com"
        session.cart_items = []
        worker = PaymentFlowWorker()
        r = await worker.run(
            session,
            {"intent": "send_payment_link"},
            settings,
        )
        assert not r.success

    @pytest.mark.asyncio
    async def test_send_payment_link_needs_tools(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="Send me the payment link",
            settings=settings,
        )
        assert decision["response_mode"] == "needs_tools"
        assert "payment_flow" in decision["tool_categories"]
