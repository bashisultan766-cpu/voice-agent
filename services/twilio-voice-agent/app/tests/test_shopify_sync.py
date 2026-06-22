"""
Tests for app/sync/shopify_sync.py — initial sync worker.

All Shopify API calls are mocked. No live network required.
"""
from __future__ import annotations

import os
import pytest
from unittest.mock import AsyncMock, patch, MagicMock

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")
os.environ.setdefault("SHOPIFY_SHOP_DOMAIN", "test.myshopify.com")
os.environ.setdefault("SHOPIFY_ADMIN_ACCESS_TOKEN", "test-token")


from app.sync.shopify_sync import (
    sync_shopify_store,
    _ingest_product,
    _ingest_customer,
    _ingest_order,
    _query_with_retry,
)


# ── _ingest_product ───────────────────────────────────────────────────────────

class TestIngestProduct:
    async def test_basic_product(self):
        from app.sync.repositories import ProductCache, CachedProduct
        cache = MagicMock(spec=ProductCache)
        cache.set = AsyncMock()

        node = {
            "id": "gid://shopify/Product/1",
            "title": "Dune",
            "handle": "dune",
            "tags": ["isbn:9780441013593", "sci-fi"],
            "variants": {"edges": [{
                "node": {
                    "id": "gid://shopify/ProductVariant/10",
                    "sku": "",
                    "barcode": "",
                    "price": "9.99",
                    "availableForSale": True,
                    "metafields": [],
                }
            }]},
        }
        await _ingest_product(node, cache)
        cache.set.assert_called_once()
        product = cache.set.call_args[0][0]
        assert product.title == "Dune"
        assert "9780441013593" in product.isbn

    async def test_isbn_from_barcode(self):
        from app.sync.repositories import ProductCache
        cache = MagicMock(spec=ProductCache)
        cache.set = AsyncMock()

        node = {
            "id": "gid://shopify/Product/2",
            "title": "Foundation",
            "handle": "foundation",
            "tags": [],
            "variants": {"edges": [{
                "node": {
                    "id": "gid://shopify/ProductVariant/20",
                    "sku": "",
                    "barcode": "9780553293357",
                    "price": "12.99",
                    "availableForSale": True,
                    "metafields": [],
                }
            }]},
        }
        await _ingest_product(node, cache)
        product = cache.set.call_args[0][0]
        assert product.isbn == "9780553293357"

    async def test_missing_title_skipped(self):
        from app.sync.repositories import ProductCache
        cache = MagicMock(spec=ProductCache)
        cache.set = AsyncMock()

        node = {"id": "gid://shopify/Product/3", "title": "", "handle": "x", "tags": [], "variants": {"edges": []}}
        await _ingest_product(node, cache)
        cache.set.assert_not_called()

    async def test_bad_node_no_crash(self):
        from app.sync.repositories import ProductCache
        cache = MagicMock(spec=ProductCache)
        cache.set = AsyncMock(side_effect=Exception("Redis error"))
        # Should not raise
        await _ingest_product({"id": "x", "title": "T", "handle": "h", "tags": [], "variants": {"edges": []}}, cache)


# ── _ingest_customer ──────────────────────────────────────────────────────────

class TestIngestCustomer:
    async def test_basic_customer(self):
        from app.sync.repositories import CustomerCache
        from app.caller.repository import mask_email
        cache = MagicMock(spec=CustomerCache)
        cache.set = AsyncMock()

        node = {
            "id": "gid://shopify/Customer/100",
            "firstName": "Alice",
            "lastName": "Smith",
            "phone": "+15551234567",
            "email": "alice@example.com",
            "orders": {"edges": [{"node": {"name": "#1001"}}]},
        }
        await _ingest_customer(node, cache, mask_email)
        cache.set.assert_called_once()
        customer = cache.set.call_args[0][0]
        assert customer.display_name == "Alice Smith"
        assert customer.normalized_phone == "15551234567"
        assert "alice@example.com" not in customer.email_masked
        assert customer.last_order_number == "#1001"

    async def test_no_phone_skipped(self):
        from app.sync.repositories import CustomerCache
        from app.caller.repository import mask_email
        cache = MagicMock(spec=CustomerCache)
        cache.set = AsyncMock()

        node = {
            "id": "gid://shopify/Customer/101",
            "firstName": "Bob",
            "lastName": "",
            "phone": "",
            "email": "bob@example.com",
            "orders": {"edges": []},
        }
        await _ingest_customer(node, cache, mask_email)
        cache.set.assert_not_called()


# ── _ingest_order ─────────────────────────────────────────────────────────────

class TestIngestOrder:
    async def test_basic_order(self):
        from app.sync.repositories import OrderCache
        from app.caller.repository import mask_email
        cache = MagicMock(spec=OrderCache)
        cache.set = AsyncMock()

        node = {
            "id": "gid://shopify/Order/200",
            "name": "#1042",
            "customer": {
                "id": "gid://shopify/Customer/100",
                "phone": "+15551234567",
                "email": "alice@example.com",
            },
            "displayFinancialStatus": "PAID",
            "displayFulfillmentStatus": "FULFILLED",
            "lineItems": {"edges": [
                {"node": {"title": "Dune", "quantity": 1}},
            ]},
            "refunds": [],
            "fulfillments": [],
        }
        await _ingest_order(node, cache, mask_email)
        cache.set.assert_called_once()
        order = cache.set.call_args[0][0]
        assert order.order_number == "#1042"
        assert "alice@example.com" not in order.email_masked
        assert order.financial_status == "PAID"
        assert order.refund_count == 0
        assert "Dune" in order.line_items_summary

    async def test_email_always_masked_in_order(self):
        from app.sync.repositories import OrderCache
        from app.caller.repository import mask_email
        cache = MagicMock(spec=OrderCache)
        cache.set = AsyncMock()

        node = {
            "id": "gid://shopify/Order/201",
            "name": "#1043",
            "customer": {"id": "gid://shopify/Customer/101", "phone": "", "email": "raw@example.com"},
            "displayFinancialStatus": "PENDING",
            "displayFulfillmentStatus": "",
            "lineItems": {"edges": []},
            "refunds": [{"id": "r1"}, {"id": "r2"}],
            "fulfillments": [],
        }
        await _ingest_order(node, cache, mask_email)
        order = cache.set.call_args[0][0]
        assert "raw@example.com" not in order.email_masked
        assert order.refund_count == 2


# ── _query_with_retry ─────────────────────────────────────────────────────────

class TestQueryWithRetry:
    async def test_success_first_try(self):
        mock_client = MagicMock()
        mock_client.query = AsyncMock(return_value={"products": {}})
        result = await _query_with_retry(mock_client, "query", {}, max_retries=3)
        assert result == {"products": {}}
        assert mock_client.query.call_count == 1

    async def test_retries_on_error(self):
        mock_client = MagicMock()
        call_count = 0

        async def flaky_query(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise Exception("network error")
            return {"ok": True}

        mock_client.query = flaky_query
        with patch("app.sync.shopify_sync.asyncio.sleep", AsyncMock()):
            result = await _query_with_retry(mock_client, "query", {}, max_retries=3)
        assert result == {"ok": True}

    async def test_exhausted_retries_returns_none(self):
        mock_client = MagicMock()
        mock_client.query = AsyncMock(side_effect=Exception("always fails"))
        with patch("app.sync.shopify_sync.asyncio.sleep", AsyncMock()):
            result = await _query_with_retry(mock_client, "query", {}, max_retries=2)
        assert result is None


# ── sync_shopify_store ────────────────────────────────────────────────────────

class TestSyncShopifyStore:
    async def test_skips_when_not_configured(self):
        from app.config import Settings
        settings = Settings(SHOPIFY_SHOP_DOMAIN="", SHOPIFY_ADMIN_ACCESS_TOKEN="", DEBUG=True)

        with patch("app.config.get_settings", return_value=settings):
            counts = await sync_shopify_store()
        assert counts == {"products": 0, "customers": 0, "orders": 0}

    async def test_returns_counts_on_success(self):
        empty_page = {"edges": [], "pageInfo": {"hasNextPage": False}}

        mock_data_by_call = [
            {"products": empty_page},
            {"customers": empty_page},
            {"orders": empty_page},
        ]
        call_index = 0

        async def mock_query(*args, **kwargs):
            nonlocal call_index
            data = mock_data_by_call[min(call_index, len(mock_data_by_call) - 1)]
            call_index += 1
            return data

        mock_client = MagicMock()
        mock_client.query = mock_query

        with patch("app.shopify.client.ShopifyGraphQLClient", return_value=mock_client):
            counts = await sync_shopify_store()

        assert counts["products"] == 0
        assert counts["customers"] == 0
        assert counts["orders"] == 0
