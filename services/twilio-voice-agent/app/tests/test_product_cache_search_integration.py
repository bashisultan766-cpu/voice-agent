"""
Tests for Feature 5 — ProductCache integration in search_products.

search_products now checks:
  1. ProductCache.get_by_isbn()
  2. ProductCache.get_by_title()
  3. ProductCache.get_by_handle()
  4. Redis search-result cache
  5. Shopify live API (fallback)
"""
from __future__ import annotations

import json
import os
import pytest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.tools.shopify_tools import search_products
from app.sync.repositories import CachedProduct


def _make_product(title="Dune", isbn="9780441172719") -> CachedProduct:
    return CachedProduct(
        product_id="gid://shopify/Product/1",
        title=title,
        handle=title.lower().replace(" ", "-"),
        isbn=isbn,
        author="Frank Herbert",
        price="18.99",
        available=True,
        variant_id="gid://shopify/ProductVariant/1",
    )


class TestSearchProductsCacheFirst:
    async def test_isbn_found_in_product_cache_no_shopify_call(self):
        """ISBN hit in ProductCache → Shopify API must NOT be called."""
        product = _make_product()
        mock_cache = AsyncMock()
        mock_cache.get_by_isbn = AsyncMock(return_value=product)
        mock_cache.get_by_title = AsyncMock(return_value=None)
        mock_cache.get_by_handle = AsyncMock(return_value=None)

        with patch("app.sync.repositories.ProductCache", return_value=mock_cache), \
             patch("app.tools.shopify_tools.get_shopify_client") as mock_client_fn:
            result = json.loads(await search_products("9780441172719"))

        mock_client_fn.assert_not_called()
        assert result.get("count") == 1
        assert result["results"][0]["title"] == "Dune"
        assert result.get("source") == "cache"

    async def test_title_found_in_product_cache_no_shopify_call(self):
        product = _make_product()
        mock_cache = AsyncMock()
        mock_cache.get_by_isbn = AsyncMock(return_value=None)
        mock_cache.get_by_title = AsyncMock(return_value=product)
        mock_cache.get_by_handle = AsyncMock(return_value=None)

        with patch("app.sync.repositories.ProductCache", return_value=mock_cache), \
             patch("app.tools.shopify_tools.get_shopify_client") as mock_client_fn:
            result = json.loads(await search_products("Dune"))

        mock_client_fn.assert_not_called()
        assert result.get("count") == 1
        assert result["results"][0]["title"] == "Dune"

    async def test_handle_found_in_product_cache_no_shopify_call(self):
        product = _make_product()
        mock_cache = AsyncMock()
        mock_cache.get_by_isbn = AsyncMock(return_value=None)
        mock_cache.get_by_title = AsyncMock(return_value=None)
        mock_cache.get_by_handle = AsyncMock(return_value=product)

        with patch("app.sync.repositories.ProductCache", return_value=mock_cache), \
             patch("app.tools.shopify_tools.get_shopify_client") as mock_client_fn:
            result = json.loads(await search_products("dune"))

        mock_client_fn.assert_not_called()
        assert result.get("count") == 1

    async def test_cache_miss_falls_back_to_shopify(self):
        mock_cache = AsyncMock()
        mock_cache.get_by_isbn = AsyncMock(return_value=None)
        mock_cache.get_by_title = AsyncMock(return_value=None)
        mock_cache.get_by_handle = AsyncMock(return_value=None)

        mock_client = AsyncMock()
        mock_client.configured = True
        mock_client.execute = AsyncMock(return_value={
            "data": {
                "products": {
                    "edges": [
                        {"node": {
                            "id": "gid://shopify/Product/1",
                            "title": "Dune",
                            "handle": "dune",
                            "onlineStoreUrl": "",
                            "variants": {"edges": [{"node": {
                                "id": "v1", "title": "Default",
                                "price": "18.99", "availableForSale": True,
                                "inventoryQuantity": 5,
                            }}]},
                        }}
                    ]
                }
            }
        })

        with patch("app.sync.repositories.ProductCache", return_value=mock_cache), \
             patch("app.tools.shopify_tools.get_shopify_client", return_value=mock_client), \
             patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)), \
             patch("app.tools.shopify_tools.shopify_cache_set", AsyncMock()):
            result = json.loads(await search_products("dune frank herbert"))

        mock_client.execute.assert_called()
        assert result.get("count", 0) >= 1

    async def test_local_result_has_normalized_shape(self):
        """Cache hit produces same key shape as Shopify API result."""
        product = _make_product()
        mock_cache = AsyncMock()
        mock_cache.get_by_isbn = AsyncMock(return_value=None)
        mock_cache.get_by_title = AsyncMock(return_value=product)
        mock_cache.get_by_handle = AsyncMock(return_value=None)

        with patch("app.sync.repositories.ProductCache", return_value=mock_cache), \
             patch("app.tools.shopify_tools.get_shopify_client"):
            result = json.loads(await search_products("Dune"))

        r = result["results"][0]
        assert "title" in r
        assert "price" in r
        assert "available" in r
        assert "id" in r

    async def test_product_cache_error_falls_through_to_shopify(self):
        """ProductCache failure must not block the search path."""
        mock_cache = AsyncMock()
        mock_cache.get_by_isbn = AsyncMock(side_effect=RuntimeError("Redis down"))
        mock_cache.get_by_title = AsyncMock(side_effect=RuntimeError("Redis down"))
        mock_cache.get_by_handle = AsyncMock(side_effect=RuntimeError("Redis down"))

        mock_client = AsyncMock()
        mock_client.configured = False  # Shopify also not configured → error response

        with patch("app.sync.repositories.ProductCache", return_value=mock_cache), \
             patch("app.tools.shopify_tools.get_shopify_client", return_value=mock_client), \
             patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            result = json.loads(await search_products("dune"))

        # Should return an error result, not crash
        assert "error" in result or "results" in result
