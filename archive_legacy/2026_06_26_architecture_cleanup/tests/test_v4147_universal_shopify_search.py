"""v4.14.7 — Universal Shopify search worker tests."""
from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.state.models import SessionState
from app.workers.universal_catalog_search_worker import UniversalCatalogSearchWorker


def _session() -> SessionState:
    return SessionState(
        session_id="s1", call_sid="CAshop1", from_number="+1", to_number="+2",
    )


@pytest.mark.asyncio
async def test_universal_search_finds_newspaper():
    worker = UniversalCatalogSearchWorker()
    session = _session()
    entities = {
        "product_kind": "newspaper",
        "publication_title": "USA Today",
        "product_phrase": "USA Today 5 day delivery 3 months",
        "product_type": "newspaper",
        "collection_hint": "newspapers",
    }
    mock_result = json.dumps({
        "results": [{
            "title": "USA Today 5 Day Delivery",
            "price": "149.99",
            "available": True,
            "variant_id": "gid://shopify/ProductVariant/1",
            "product_id": "gid://shopify/Product/1",
            "product_type": "newspaper",
        }],
        "count": 1,
    })

    with patch("app.tools.shopify_tools.search_products", new=AsyncMock(return_value=mock_result)):
        with patch("app.sync.repositories.ProductCache") as MockCache:
            cache = MockCache.return_value
            cache.get_by_title = AsyncMock(return_value=None)
            cache.get_by_handle = AsyncMock(return_value=None)
            cache.get_by_isbn = AsyncMock(return_value=None)
            result = await worker.run(session, entities, settings=None)

    assert result.success
    assert result.data.get("title")
    assert "USA Today" in result.data.get("title", "")


@pytest.mark.asyncio
async def test_universal_search_not_found():
    worker = UniversalCatalogSearchWorker()
    session = _session()
    entities = {
        "product_kind": "newspaper",
        "publication_title": "Unknown Paper XYZ",
        "product_phrase": "Unknown Paper XYZ",
    }
    mock_empty = json.dumps({"results": [], "count": 0})

    with patch("app.tools.shopify_tools.search_products", new=AsyncMock(return_value=mock_empty)):
        with patch("app.sync.repositories.ProductCache") as MockCache:
            cache = MockCache.return_value
            cache.get_by_title = AsyncMock(return_value=None)
            cache.get_by_handle = AsyncMock(return_value=None)
            result = await worker.run(session, entities, settings=None)

    assert result.success
    assert result.data.get("not_found") is True
