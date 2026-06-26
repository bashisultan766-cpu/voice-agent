"""
v4.1.2 tests — payment flow state machine and checkout gating.

Covers:
 - payment_flow_status advances on email_provided → awaiting_email_confirmation
 - payment_flow_status advances on email_confirmation → awaiting_send_confirmation
 - payment_flow_status reverts on email_correction → awaiting_email
 - create_checkout_link blocked during awaiting_email_confirmation
 - create_checkout_link unblocked during awaiting_send_confirmation
 - send_payment_link_email_tool still blocked without confirmed_email
 - payment_flow_status advances to payment_sent on successful send
 - price_question → PriceInventoryWorker worker path
 - PriceInventoryWorker returns helpful message when no product_id
 - PriceInventoryWorker returns "no confirmed price" message when price is None
 - Diagnostic payment_tool_result logs are emitted
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")


def _make_session(*, pfs="idle", confirmed_email="", pending_email=""):
    from app.state.models import SessionState
    s = SessionState(
        session_id="s-pay", call_sid="CA00000412",
        from_number="+15550001234", to_number="+15559998888",
    )
    s.payment_flow_status = pfs
    s.confirmed_email = confirmed_email
    s.pending_email = pending_email
    return s


def _make_settings():
    from unittest.mock import MagicMock
    return MagicMock()


# ── Payment flow state transitions ────────────────────────────────────────────

class TestPaymentFlowStateTransitions:
    def test_email_provided_sets_awaiting_confirmation(self):
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult
        session = _make_session()
        intent = IntentResult(
            intent="email_provided", confidence=0.85,
            entities={"email": "alice@example.com", "email_raw": "alice at example dot com"},
        )
        _apply_email_state(session, intent)
        assert session.payment_flow_status == "awaiting_email_confirmation"
        assert session.pending_email == "alice@example.com"

    def test_email_confirmation_advances_to_awaiting_send(self):
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult
        session = _make_session(pending_email="alice@example.com", pfs="awaiting_email_confirmation")
        intent = IntentResult(intent="email_confirmation", confidence=0.95, entities={})
        _apply_email_state(session, intent)
        assert session.confirmed_email == "alice@example.com"
        assert session.pending_email == ""
        assert session.payment_flow_status == "awaiting_send_confirmation"

    def test_email_correction_reverts_to_awaiting_email(self):
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult
        session = _make_session(pending_email="alice@example.com", pfs="awaiting_email_confirmation")
        intent = IntentResult(intent="email_correction", confidence=0.9, entities={})
        _apply_email_state(session, intent)
        assert session.pending_email == ""
        assert session.payment_flow_status == "awaiting_email"

    def test_email_provided_when_already_confirmed_does_not_change_status(self):
        # If confirmed_email is already set, providing new email = update pending only
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult
        session = _make_session(confirmed_email="old@example.com", pfs="awaiting_send_confirmation")
        intent = IntentResult(
            intent="email_provided", confidence=0.85,
            entities={"email": "new@example.com"},
        )
        _apply_email_state(session, intent)
        # confirmed_email unchanged, new pending set
        assert session.confirmed_email == "old@example.com"
        assert session.pending_email == "new@example.com"


# ── Checkout blocked during email confirmation ────────────────────────────────

class TestCheckoutGating:
    async def test_blocks_during_awaiting_email_confirmation(self):
        from app.tools.shopify_tools import create_checkout_link
        session = _make_session(pfs="awaiting_email_confirmation")
        session.cart_items = [{"variant_id": "gid://shopify/Variant/1", "quantity": 1, "title": "Book"}]
        result_json = await create_checkout_link(
            items=[{"variant_id": "gid://shopify/Variant/1", "quantity": 1}],
            session=session,
        )
        import json
        result = json.loads(result_json)
        assert result.get("success") is False
        assert "confirm" in result["error"].lower() or "email" in result["error"].lower()

    async def test_unblocked_during_awaiting_send_confirmation(self):
        from unittest.mock import AsyncMock, patch, MagicMock
        from app.tools.shopify_tools import create_checkout_link
        session = _make_session(
            pfs="awaiting_send_confirmation",
            confirmed_email="alice@example.com",
        )
        session.cart_items = [{"variant_id": "gid://shopify/Variant/1", "quantity": 1, "title": "Book"}]

        mock_client = MagicMock()
        mock_client.configured = True
        mock_client.execute = AsyncMock(return_value={
            "data": {"draftOrderCreate": {
                "draftOrder": {"invoiceUrl": "https://example.com/pay/1", "name": "D-001"},
                "userErrors": [],
            }}
        })
        with patch("app.tools.shopify_tools.get_shopify_client", return_value=mock_client):
            result_json = await create_checkout_link(
                items=[{"variant_id": "gid://shopify/Variant/1", "quantity": 1}],
                session=session,
            )
        import json
        result = json.loads(result_json)
        assert result.get("success") is True

    async def test_no_session_proceeds_normally(self):
        # Without session, no gating at all
        from unittest.mock import AsyncMock, patch, MagicMock
        from app.tools.shopify_tools import create_checkout_link
        mock_client = MagicMock()
        mock_client.configured = True
        mock_client.execute = AsyncMock(return_value={
            "data": {"draftOrderCreate": {
                "draftOrder": {"invoiceUrl": "https://example.com/pay/1", "name": "D-002"},
                "userErrors": [],
            }}
        })
        with patch("app.tools.shopify_tools.get_shopify_client", return_value=mock_client):
            result_json = await create_checkout_link(
                items=[{"variant_id": "gid://shopify/Variant/1", "quantity": 1}],
                session=None,
            )
        import json
        result = json.loads(result_json)
        assert result.get("success") is True


# ── Payment email tool state advancement ─────────────────────────────────────

class TestPaymentEmailStateAdvancement:
    async def test_successful_send_sets_payment_sent(self):
        from unittest.mock import AsyncMock, patch
        from app.tools.shopify_tools import send_payment_link_email_tool
        session = _make_session(
            confirmed_email="alice@example.com",
            pfs="awaiting_send_confirmation",
        )
        session.pending_checkout_url = "https://example.com/pay/1"

        mock_send = AsyncMock(return_value={"success": True})
        with patch("app.tools.shopify_tools.send_payment_link_email", mock_send):
            result_json = await send_payment_link_email_tool(
                email="alice@example.com",
                session=session,
            )
        import json
        result = json.loads(result_json)
        assert result.get("success") is True
        assert session.payment_flow_status == "payment_sent"


# ── Price question → worker path ──────────────────────────────────────────────

class TestPriceQuestionWorkerPath:
    def test_price_question_in_worker_path(self):
        from app.workers.orchestrator import WORKER_PATH_INTENTS
        assert "price_question" in WORKER_PATH_INTENTS

    def test_price_question_maps_to_price_inventory(self):
        from app.workers.orchestrator import _INTENT_WORKERS
        assert "price_inventory" in _INTENT_WORKERS.get("price_question", [])

    async def test_price_inventory_helpful_message_no_product(self):
        from app.workers.price_inventory_worker import PriceInventoryWorker
        worker = PriceInventoryWorker()
        session = _make_session()
        # No last_product_id set
        result = await worker.run(session, {}, _make_settings())
        assert result.success is False
        assert result.error_code == "no_product_id"
        assert "book" in (result.safe_summary or "").lower() or "price" in (result.safe_summary or "").lower()

    async def test_price_inventory_handles_missing_price(self):
        from unittest.mock import AsyncMock, MagicMock, patch
        from app.workers.price_inventory_worker import PriceInventoryWorker
        worker = PriceInventoryWorker()
        session = _make_session()
        session.last_product_id = "gid://shopify/Product/123"

        mock_product = MagicMock()
        mock_product.title = "Test Book"
        mock_product.price = None
        mock_product.currency = "USD"
        mock_product.available = True

        mock_cache = AsyncMock()
        mock_cache.get_by_id = AsyncMock(return_value=mock_product)
        mock_cache_cls = MagicMock(return_value=mock_cache)

        # Patch at the sync.repositories import point used by the worker
        with patch("app.sync.repositories.ProductCache", mock_cache_cls):
            result = await worker.run(session, {}, _make_settings())
        assert result.success is True
        summary = result.safe_summary or ""
        assert "don't have a confirmed price" in summary.lower() or "not" in summary.lower()


# ── Diagnostic logging ────────────────────────────────────────────────────────

class TestDiagnosticLogging:
    async def test_checkout_blocked_logs_reason(self, caplog):
        import logging
        from app.tools.shopify_tools import create_checkout_link
        session = _make_session(pfs="awaiting_email_confirmation")
        session.cart_items = [{"variant_id": "gid://shopify/Variant/1", "quantity": 1, "title": "Book"}]
        with caplog.at_level(logging.INFO, logger="app.tools.shopify_tools"):
            await create_checkout_link(
                items=[{"variant_id": "gid://shopify/Variant/1", "quantity": 1}],
                session=session,
            )
        log_text = caplog.text
        assert "payment_tool_result" in log_text
        assert "allowed=false" in log_text

    async def test_send_blocked_logs_reason(self, caplog):
        import logging
        from app.tools.shopify_tools import send_payment_link_email_tool
        session = _make_session()  # no confirmed_email, no checkout_url
        with caplog.at_level(logging.INFO):
            await send_payment_link_email_tool(email="x@example.com", session=session)
        log_text = caplog.text
        assert "payment_send_blocked" in log_text or "payment_tool_result" in log_text
        assert "email_unconfirmed" in log_text or "allowed=false" in log_text
