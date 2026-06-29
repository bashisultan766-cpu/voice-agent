"""v4.40 — ISBN resolution in LLM-only mode (catalog_search query normalization)."""
from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest

from app.agent_runtime.isbn_short_circuit import (
    ISBN_SHORT_CIRCUIT_VERSION,
    normalize_catalog_search_query,
    prepare_isbn_turn_context,
)
from app.agent_runtime.llm_tools import CatalogSearchArgs, _catalog_search
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="v440",
        call_sid="CAbe7fb205b20151b2214fa699d2a6e557",
        from_number="+1",
        to_number="+2",
    )
    base.update(kwargs)
    return SessionState(**base)


class TestIsbnNormalization:
    def test_version(self):
        assert ISBN_SHORT_CIRCUIT_VERSION == "v4.44"

    def test_spaced_isbn_normalizes(self):
        q, isbn = normalize_catalog_search_query("9 7 8 1 6 4 5 5 6 3 2 4 2.")
        assert isbn == "9781645563242"
        assert q == "9781645563242"

    def test_wrong_checksum_fragment_not_used_as_isbn(self):
        q, isbn = normalize_catalog_search_query("9781645556324")
        assert isbn is None
        assert q == "9781645556324"

    def test_prepare_sets_resolved_isbn_on_session(self):
        session = _session()
        isbn = prepare_isbn_turn_context(
            session,
            "The ISBN number is 9 7 8 1 6 4 5 5 6 3 2 4 2.",
            turn_mode="isbn",
        )
        assert isbn == "9781645563242"
        assert session.last_resolved_isbn_for_turn == "9781645563242"


class TestCatalogSearchTool:
    @pytest.mark.asyncio
    async def test_catalog_search_uses_normalized_isbn(self, monkeypatch):
        session = _session()
        captured: dict = {}

        async def fake_isbn_search(isbn: str):
            captured["isbn"] = isbn
            return json.dumps({
                "found": True,
                "normalized_isbn": isbn,
                "product": {
                    "product_id": "p1",
                    "variant_id": "v1",
                    "title": "A Thug's Heartbeat",
                    "price": "8.99",
                    "available": True,
                    "author": "",
                },
                "count": 1,
            })

        monkeypatch.setattr("app.tools.shopify_tools.search_product_by_isbn", fake_isbn_search)

        raw = await _catalog_search(
            CatalogSearchArgs(query="9 7 8 1 6 4 5 5 6 3 2 4 2", limit=5),
            session,
        )
        payload = json.loads(raw)
        assert captured["isbn"] == "9781645563242"
        assert payload["found"] is True
