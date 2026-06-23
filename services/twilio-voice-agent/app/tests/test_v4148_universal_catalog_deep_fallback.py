"""v4.14.8 — Universal catalog deep fallback tests."""
from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.state.models import SessionState
from app.tests.test_v4148_shopify_catalog_scanner import _draft_product
from app.workers.universal_catalog_search_worker import UniversalCatalogSearchWorker


def _session() -> SessionState:
    return SessionState(session_id="s1", call_sid="CAdeep1", from_number="+1", to_number="+2")


@pytest.mark.asyncio
async def test_deep_fallback_returns_non_orderable_draft():
    worker = UniversalCatalogSearchWorker()
    entities = {
        "product_kind": "newspaper",
        "publication_title": "USA Today",
        "product_phrase": "USA Today",
    }
    empty = json.dumps({"results": [], "count": 0})
    draft = _draft_product()

    with patch("app.tools.shopify_tools.search_products", new=AsyncMock(return_value=empty)):
        with patch("app.sync.repositories.ProductCache") as MockCache:
            cache = MockCache.return_value
            cache.get_by_title = AsyncMock(return_value=None)
            cache.get_by_handle = AsyncMock(return_value=None)
            cache.get_by_isbn = AsyncMock(return_value=None)
            with patch(
                "app.integrations.shopify_catalog_scanner.deep_search_term",
                new=AsyncMock(return_value=[draft]),
            ):
                result = await worker.run(_session(), entities, settings=None)

    assert result.success
    assert result.data.get("not_orderable") is True
    assert result.data.get("can_add_to_cart") is False


@pytest.mark.asyncio
async def test_not_found_includes_diagnostics():
    worker = UniversalCatalogSearchWorker()
    entities = {"product_kind": "newspaper", "publication_title": "Unknown Paper XYZ", "product_phrase": "Unknown Paper XYZ"}
    empty = json.dumps({"results": [], "count": 0})

    with patch("app.tools.shopify_tools.search_products", new=AsyncMock(return_value=empty)):
        with patch("app.sync.repositories.ProductCache") as MockCache:
            cache = MockCache.return_value
            cache.get_by_title = AsyncMock(return_value=None)
            cache.get_by_handle = AsyncMock(return_value=None)
            with patch("app.integrations.shopify_catalog_scanner.deep_search_term", new=AsyncMock(return_value=[])):
                with patch(
                    "app.agent_runtime.catalog_coverage_diagnostics.diagnose_catalog_visibility",
                    new=AsyncMock(return_value=type("D", (), {
                        "to_dict": lambda self: {"likely_issue": "no match"},
                        "likely_issue": "no match",
                    })()),
                ):
                    result = await worker.run(_session(), entities, settings=None)

    assert result.data.get("not_found") is True
    assert "diagnostics" in result.data
