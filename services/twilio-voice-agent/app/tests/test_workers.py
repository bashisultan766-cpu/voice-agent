"""
Tests for app/workers/* — all 13 deterministic async workers.

Critical invariants verified:
- No worker imports openai.
- No worker calls run_agent_turn.
- Workers return WorkerResult (never raise).
- Cache-first behavior (no Shopify call on cache hit).
- Verification gating on sensitive data.
"""
from __future__ import annotations

import ast
import os
import pathlib
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.workers.base import WorkerResult, WorkerBundle
from app.state.models import SessionState


def _make_session(**kwargs) -> SessionState:
    defaults = dict(
        session_id="s-worker",
        call_sid="CA_WORK01",
        from_number="+15551234567",
        to_number="+18005551234",
    )
    defaults.update(kwargs)
    return SessionState(**defaults)


def _make_settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True, VOICE_TOOL_TIMEOUT_MS=2500)


# ── Security: no worker may import openai ────────────────────────────────────

class TestWorkerSecurityConstraints:
    """Enforce the Single-LLM rule at source level."""

    def _worker_files(self):
        workers_dir = pathlib.Path(__file__).parent.parent / "workers"
        return [f for f in workers_dir.glob("*.py") if f.name not in ("__init__.py", "base.py", "orchestrator.py")]

    def test_no_worker_imports_openai(self):
        """Workers must NEVER import openai — only MainLLMComposer may."""
        for py_file in self._worker_files():
            source = py_file.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(py_file))
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    names = (
                        [alias.name for alias in node.names]
                        if isinstance(node, ast.Import)
                        else [node.module or ""]
                    )
                    for name in names:
                        assert "openai" not in (name or "").lower(), (
                            f"{py_file.name} imports openai — only MainLLMComposer may"
                        )

    def test_no_worker_imports_run_agent_turn(self):
        """Workers must not IMPORT run_agent_turn (docstrings mentioning it are fine)."""
        for py_file in self._worker_files():
            source = py_file.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(py_file))
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    if isinstance(node, ast.ImportFrom):
                        names = [alias.name for alias in node.names]
                    else:
                        names = [alias.name for alias in node.names]
                    assert "run_agent_turn" not in names, (
                        f"{py_file.name} imports run_agent_turn — only engine.py fallback path may use it"
                    )


# ── WorkerResult / WorkerBundle ───────────────────────────────────────────────

class TestWorkerResult:
    def test_defaults(self):
        r = WorkerResult(worker_name="test", success=True)
        assert r.data == {}
        assert r.safe_summary == ""
        assert r.requires_verification is False
        assert r.error_code is None
        assert r.latency_ms == 0.0
        assert r.source == "none"

    def test_fields(self):
        r = WorkerResult(
            worker_name="order_lookup",
            success=True,
            data={"order_number": "#1042"},
            safe_summary="Order found.",
            requires_verification=True,
            latency_ms=123.4,
            source="shopify",
        )
        assert r.worker_name == "order_lookup"
        assert r.requires_verification is True
        assert r.source == "shopify"


class TestWorkerBundle:
    def test_empty_bundle_context(self):
        bundle = WorkerBundle()
        ctx = bundle.to_llm_context()
        assert "[WORKER DATA" in ctx
        assert "No worker data" in ctx

    def test_successful_result_included(self):
        bundle = WorkerBundle()
        bundle.results["product_isbn"] = WorkerResult(
            worker_name="product_isbn",
            success=True,
            safe_summary="Found 'Dune', in stock, $18.99.",
        )
        ctx = bundle.to_llm_context()
        assert "Dune" in ctx

    def test_verification_gated_when_unverified(self):
        bundle = WorkerBundle()
        bundle.results["refund"] = WorkerResult(
            worker_name="refund",
            success=True,
            safe_summary="Refund of $25.00 on 2026-01-15.",
            requires_verification=True,
        )
        ctx = bundle.to_llm_context(verified_email=False, verified_phone=False)
        assert "25.00" not in ctx
        assert "verification" in ctx

    def test_verification_unlocked_when_verified(self):
        bundle = WorkerBundle()
        bundle.results["refund"] = WorkerResult(
            worker_name="refund",
            success=True,
            safe_summary="Refund of $25.00 on 2026-01-15.",
            requires_verification=True,
        )
        ctx = bundle.to_llm_context(verified_email=True)
        assert "25.00" in ctx

    def test_failed_result_shows_unavailable_for_actionable_errors(self):
        bundle = WorkerBundle()
        bundle.results["order_lookup"] = WorkerResult(
            worker_name="order_lookup",
            success=False,
            error_code="shopify_error",
        )
        ctx = bundle.to_llm_context()
        assert "unavailable" in ctx

    def test_failed_result_silent_for_non_actionable_codes(self):
        bundle = WorkerBundle()
        bundle.results["price_inventory"] = WorkerResult(
            worker_name="price_inventory",
            success=False,
            error_code="not_configured",
        )
        ctx = bundle.to_llm_context()
        # not_configured is not shown (silent skip)
        assert "price_inventory" not in ctx

    def test_successful_returns_only_successes(self):
        bundle = WorkerBundle()
        bundle.results["a"] = WorkerResult(worker_name="a", success=True)
        bundle.results["b"] = WorkerResult(worker_name="b", success=False)
        assert len(bundle.successful()) == 1


# ── CallerIdentityWorker ──────────────────────────────────────────────────────

class TestCallerIdentityWorker:
    async def test_returns_result_on_cache_hit(self):
        from app.workers.caller_identity_worker import CallerIdentityWorker
        from app.sync.repositories import CachedCustomer
        worker = CallerIdentityWorker()
        session = _make_session()
        mock_cache = AsyncMock()
        mock_cache.get_by_phone = AsyncMock(return_value=CachedCustomer(
            customer_id="gid://shopify/Customer/1",
            normalized_phone="15551234567",
            display_name="Alice",
            email_masked="a***@example.com",
            last_order_number="#1042",
        ))
        with patch("app.sync.repositories.CustomerCache", return_value=mock_cache):
            result = await worker.run(session, {}, _make_settings())
        assert result.success is True
        assert "Alice" in result.safe_summary
        assert result.source == "cache"

    async def test_cache_miss_returns_success_no_data(self):
        from app.workers.caller_identity_worker import CallerIdentityWorker
        worker = CallerIdentityWorker()
        session = _make_session()
        mock_cache = AsyncMock()
        mock_cache.get_by_phone = AsyncMock(return_value=None)
        with patch("app.sync.repositories.CustomerCache", return_value=mock_cache):
            result = await worker.run(session, {}, _make_settings())
        assert result.success is True
        assert result.source == "cache"

    async def test_cache_error_returns_failure_no_crash(self):
        from app.workers.caller_identity_worker import CallerIdentityWorker
        worker = CallerIdentityWorker()
        session = _make_session()
        mock_cache = AsyncMock()
        mock_cache.get_by_phone = AsyncMock(side_effect=RuntimeError("Redis down"))
        with patch("app.sync.repositories.CustomerCache", return_value=mock_cache):
            result = await worker.run(session, {}, _make_settings())
        assert result.success is False
        assert result.error_code == "cache_error"

    async def test_populates_session_caller_name(self):
        from app.workers.caller_identity_worker import CallerIdentityWorker
        from app.sync.repositories import CachedCustomer
        worker = CallerIdentityWorker()
        session = _make_session()
        mock_cache = AsyncMock()
        mock_cache.get_by_phone = AsyncMock(return_value=CachedCustomer(
            customer_id="gid://shopify/Customer/1",
            normalized_phone="15551234567",
            display_name="Bob",
            email_masked="b***@example.com",
        ))
        with patch("app.sync.repositories.CustomerCache", return_value=mock_cache):
            await worker.run(session, {}, _make_settings())
        assert session.caller_name == "Bob"


# ── ProductISBNWorker ─────────────────────────────────────────────────────────

class TestProductISBNWorker:
    async def test_cache_hit_no_shopify_call(self):
        from app.workers.product_isbn_worker import ProductISBNWorker
        from app.sync.repositories import CachedProduct
        worker = ProductISBNWorker()
        session = _make_session()
        product = CachedProduct(
            product_id="gid://shopify/Product/1",
            title="Dune",
            handle="dune",
            isbn="9780441172719",
            author="Frank Herbert",
            price="18.99",
            available=True,
        )
        mock_cache = AsyncMock()
        mock_cache.get_by_isbn = AsyncMock(return_value=product)
        with patch("app.sync.repositories.ProductCache", return_value=mock_cache), \
             patch("app.tools.shopify_tools.search_products") as mock_search:
            result = await worker.run(session, {"isbn": "9780441172719"}, _make_settings())
        mock_search.assert_not_called()
        assert result.success is True
        assert result.source == "cache"
        assert "Dune" in result.safe_summary

    async def test_no_isbn_returns_failure(self):
        from app.workers.product_isbn_worker import ProductISBNWorker
        worker = ProductISBNWorker()
        session = _make_session()
        result = await worker.run(session, {}, _make_settings())
        assert result.success is False
        assert result.error_code == "no_isbn"

    async def test_cache_miss_falls_back_to_shopify(self):
        from app.workers.product_isbn_worker import ProductISBNWorker
        import json
        worker = ProductISBNWorker()
        session = _make_session()
        mock_cache = AsyncMock()
        mock_cache.get_by_isbn = AsyncMock(return_value=None)
        shopify_response = json.dumps({
            "results": [{"title": "Dune", "price": "18.99", "available": True}],
            "count": 1,
        })
        with patch("app.sync.repositories.ProductCache", return_value=mock_cache), \
             patch("app.tools.shopify_tools.search_products", AsyncMock(return_value=shopify_response)):
            result = await worker.run(session, {"isbn": "9780441172719"}, _make_settings())
        assert result.success is True
        assert result.source == "shopify"


# ── ProductSearchWorker ───────────────────────────────────────────────────────

class TestProductSearchWorker:
    async def test_title_cache_hit_no_shopify(self):
        from app.workers.product_search_worker import ProductSearchWorker
        from app.sync.repositories import CachedProduct
        worker = ProductSearchWorker()
        session = _make_session()
        product = CachedProduct(
            product_id="gid://shopify/Product/2",
            title="Foundation",
            handle="foundation",
            price="12.99",
            available=True,
        )
        mock_cache = AsyncMock()
        mock_cache.get_by_title = AsyncMock(return_value=product)
        mock_cache.get_by_handle = AsyncMock(return_value=None)
        with patch("app.sync.repositories.ProductCache", return_value=mock_cache), \
             patch("app.tools.shopify_tools.search_products") as ms:
            result = await worker.run(session, {"product_phrase": "Foundation"}, _make_settings())
        ms.assert_not_called()
        assert result.success is True
        assert result.source == "cache"

    async def test_handle_cache_hit_no_shopify(self):
        from app.workers.product_search_worker import ProductSearchWorker
        from app.sync.repositories import CachedProduct
        worker = ProductSearchWorker()
        session = _make_session()
        product = CachedProduct(
            product_id="gid://shopify/Product/3",
            title="Foundation",
            handle="foundation",
            price="12.99",
            available=True,
        )
        mock_cache = AsyncMock()
        mock_cache.get_by_title = AsyncMock(return_value=None)
        mock_cache.get_by_handle = AsyncMock(return_value=product)
        with patch("app.sync.repositories.ProductCache", return_value=mock_cache), \
             patch("app.tools.shopify_tools.search_products") as ms:
            result = await worker.run(session, {"product_phrase": "foundation"}, _make_settings())
        ms.assert_not_called()
        assert result.source == "cache"

    async def test_cache_miss_calls_shopify(self):
        from app.workers.product_search_worker import ProductSearchWorker
        import json
        worker = ProductSearchWorker()
        session = _make_session()
        mock_cache = AsyncMock()
        mock_cache.get_by_title = AsyncMock(return_value=None)
        mock_cache.get_by_handle = AsyncMock(return_value=None)
        shopify_response = json.dumps({
            "results": [{"title": "Foundation", "price": "12.99", "available": True}],
            "count": 1,
        })
        with patch("app.sync.repositories.ProductCache", return_value=mock_cache), \
             patch("app.tools.shopify_tools.search_products",
                   AsyncMock(return_value=shopify_response)):
            result = await worker.run(session, {"product_phrase": "Foundation"}, _make_settings())
        assert result.source == "shopify"

    async def test_no_query_returns_failure(self):
        from app.workers.product_search_worker import ProductSearchWorker
        worker = ProductSearchWorker()
        result = await worker.run(_make_session(), {}, _make_settings())
        assert result.success is False
        assert result.error_code == "no_query"


# ── OrderLookupWorker ─────────────────────────────────────────────────────────

class TestOrderLookupWorker:
    async def test_cache_hit_no_shopify(self):
        from app.workers.order_lookup_worker import OrderLookupWorker
        from app.sync.repositories import CachedOrder
        worker = OrderLookupWorker()
        session = _make_session()
        order = CachedOrder(
            order_id="gid://shopify/Order/1",
            order_number="#1042",
            financial_status="paid",
            fulfillment_status="fulfilled",
        )
        mock_cache = AsyncMock()
        mock_cache.get_by_number = AsyncMock(return_value=order)
        with patch("app.sync.repositories.OrderCache", return_value=mock_cache), \
             patch("app.tools.shopify_tools.lookup_order") as ms:
            result = await worker.run(session, {"order_number": "#1042"}, _make_settings())
        ms.assert_not_called()
        assert result.success is True
        assert result.source == "cache"
        assert "#1042" in result.safe_summary

    async def test_no_order_number_returns_failure(self):
        from app.workers.order_lookup_worker import OrderLookupWorker
        worker = OrderLookupWorker()
        result = await worker.run(_make_session(), {}, _make_settings())
        assert result.success is False
        assert result.error_code == "no_order_number"

    async def test_requires_verification_when_unverified(self):
        from app.workers.order_lookup_worker import OrderLookupWorker
        from app.sync.repositories import CachedOrder
        worker = OrderLookupWorker()
        session = _make_session()  # not verified
        order = CachedOrder(
            order_id="gid://shopify/Order/1",
            order_number="#1042",
            financial_status="paid",
        )
        mock_cache = AsyncMock()
        mock_cache.get_by_number = AsyncMock(return_value=order)
        with patch("app.sync.repositories.OrderCache", return_value=mock_cache):
            result = await worker.run(session, {"order_number": "#1042"}, _make_settings())
        assert result.requires_verification is True


# ── RefundWorker ──────────────────────────────────────────────────────────────

class TestRefundWorker:
    async def test_unverified_caller_returns_verification_prompt(self):
        from app.workers.refund_worker import RefundWorker
        worker = RefundWorker()
        session = _make_session()  # not verified
        result = await worker.run(session, {"order_number": "#1042"}, _make_settings())
        assert result.success is True
        assert result.requires_verification is True
        assert result.source == "none"
        # Shopify should NOT have been called
        assert result.error_code is None

    async def test_verified_caller_hits_shopify(self):
        from app.workers.refund_worker import RefundWorker
        import json
        worker = RefundWorker()
        session = _make_session(verified_email=True, caller_email="alice@example.com")
        shopify_response = json.dumps({
            "found": True,
            "order_number": "#1042",
            "refund_count": 1,
            "refunds": [{"amount": "25.00 USD", "date": "2026-01-15", "items": [], "refunded_via": []}],
        })
        with patch("app.tools.shopify_tools.get_refund_status",
                   AsyncMock(return_value=shopify_response)):
            result = await worker.run(session, {"order_number": "#1042"}, _make_settings())
        assert result.success is True
        assert result.requires_verification is False
        assert "25.00" in result.safe_summary

    async def test_no_order_number_returns_failure(self):
        from app.workers.refund_worker import RefundWorker
        worker = RefundWorker()
        result = await worker.run(_make_session(), {}, _make_settings())
        assert result.success is False
        assert result.error_code == "no_order_number"


# ── TrackingWorker ────────────────────────────────────────────────────────────

class TestTrackingWorker:
    async def test_returns_tracking_from_cache(self):
        from app.workers.tracking_worker import TrackingWorker
        from app.sync.repositories import CachedOrder
        worker = TrackingWorker()
        session = _make_session()
        order = CachedOrder(
            order_id="gid://shopify/Order/1",
            order_number="#1042",
            fulfillment_status="fulfilled",
            tracking_summary="UPS, expected June 25",
        )
        mock_cache = AsyncMock()
        mock_cache.get_by_number = AsyncMock(return_value=order)
        with patch("app.sync.repositories.OrderCache", return_value=mock_cache):
            result = await worker.run(session, {"order_number": "#1042"}, _make_settings())
        assert result.success is True
        assert "UPS" in result.safe_summary
        assert result.source == "cache"


# ── ShippingWorker ────────────────────────────────────────────────────────────

class TestShippingWorker:
    async def test_returns_policy_text(self):
        from app.workers.shipping_worker import ShippingWorker
        worker = ShippingWorker()
        result = await worker.run(_make_session(), {}, _make_settings())
        assert result.success is True
        assert result.source == "local"
        assert len(result.safe_summary) > 10


# ── CheckoutWorker ────────────────────────────────────────────────────────────

class TestCheckoutWorker:
    async def test_duplicate_guard(self):
        from app.workers.checkout_worker import CheckoutWorker
        worker = CheckoutWorker()
        session = _make_session()
        session.pending_checkout_url = "https://example.com/checkout/123"
        result = await worker.run(session, {}, _make_settings())
        assert result.success is True
        assert result.data.get("duplicate") is True
        assert result.source == "local"

    async def test_no_items_returns_failure(self):
        from app.workers.checkout_worker import CheckoutWorker
        worker = CheckoutWorker()
        session = _make_session()  # empty cart
        result = await worker.run(session, {}, _make_settings())
        assert result.success is False
        assert result.error_code == "no_items"


# ── PaymentEmailWorker ────────────────────────────────────────────────────────

class TestPaymentEmailWorker:
    async def test_no_email_returns_failure(self):
        from app.workers.payment_email_worker import PaymentEmailWorker
        worker = PaymentEmailWorker()
        session = _make_session()
        result = await worker.run(session, {}, _make_settings())
        assert result.success is False
        assert result.error_code == "no_email"

    async def test_no_checkout_url_returns_failure(self):
        from app.workers.payment_email_worker import PaymentEmailWorker
        worker = PaymentEmailWorker()
        session = _make_session()
        result = await worker.run(session, {"email": "alice@example.com"}, _make_settings())
        assert result.success is False
        assert result.error_code == "no_checkout_url"

    async def test_duplicate_send_guard(self):
        from app.workers.payment_email_worker import PaymentEmailWorker
        worker = PaymentEmailWorker()
        session = _make_session()
        session.pending_checkout_url = "https://example.com/pay/123"
        session.payment_email_sent_to = ["alice@example.com"]
        result = await worker.run(session, {"email": "alice@example.com"}, _make_settings())
        assert result.success is True
        assert result.data.get("duplicate") is True


# ── EscalationWorker ──────────────────────────────────────────────────────────

class TestEscalationWorker:
    async def test_escalation_succeeds(self):
        from app.workers.escalation_worker import EscalationWorker
        import json
        worker = EscalationWorker()
        session = _make_session()
        mock_result = json.dumps({"escalated": True, "message": "Flagged for team."})
        with patch("app.tools.shopify_tools.escalate_to_human",
                   AsyncMock(return_value=mock_result)):
            result = await worker.run(session, {}, _make_settings())
        assert result.success is True
        assert "Flagged" in result.safe_summary


# ── StorePolicyWorker ─────────────────────────────────────────────────────────

class TestStorePolicyWorker:
    async def test_returns_policy_data(self):
        from app.workers.store_policy_worker import StorePolicyWorker
        worker = StorePolicyWorker()
        result = await worker.run(_make_session(), {}, _make_settings())
        assert result.success is True
        assert "refund_policy" in result.data
        assert "shipping_policy" in result.data
        assert result.source == "local"


# ── PriceInventoryWorker ──────────────────────────────────────────────────────

class TestPriceInventoryWorker:
    async def test_no_product_id_returns_failure(self):
        from app.workers.price_inventory_worker import PriceInventoryWorker
        worker = PriceInventoryWorker()
        result = await worker.run(_make_session(), {}, _make_settings())
        assert result.success is False
        assert result.error_code == "no_product_id"

    async def test_product_found_in_cache(self):
        from app.workers.price_inventory_worker import PriceInventoryWorker
        from app.sync.repositories import CachedProduct
        worker = PriceInventoryWorker()
        session = _make_session()
        session.last_product_id = "gid://shopify/Product/5"
        product = CachedProduct(
            product_id="gid://shopify/Product/5",
            title="Neuromancer",
            handle="neuromancer",
            price="14.99",
            currency="USD",
            available=True,
        )
        mock_cache = AsyncMock()
        mock_cache.get_by_id = AsyncMock(return_value=product)
        with patch("app.sync.repositories.ProductCache", return_value=mock_cache):
            result = await worker.run(session, {}, _make_settings())
        assert result.success is True
        assert "14.99" in result.safe_summary
        assert result.source == "cache"
