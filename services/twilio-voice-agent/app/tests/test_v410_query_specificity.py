"""v4.10 — query specificity and generic search blocker tests."""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.cart.candidate import save_product_candidate
from app.cart.candidate_guard import should_save_candidate
from app.catalog.query_specificity import (
    is_generic_product_query,
    score_product_query_specificity,
)
from app.pipeline.compound_intent import detect
from app.state.models import SessionState
from app.workers.product_search_worker import ProductSearchWorker


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="qs", call_sid="CA_QS01",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


class TestQuerySpecificity:
    def test_generic_book_blocked(self):
        assert is_generic_product_query("I need a book")
        assert is_generic_product_query("a book can you please provide")

    def test_just_mercy_allowed(self):
        spec = score_product_query_specificity("Just Mercy")
        assert spec.is_searchable

    def test_subject_search_no_auto_candidate(self):
        spec = score_product_query_specificity("books about parenting")
        assert spec.is_searchable
        assert not spec.may_save_candidate

    def test_router_vague_long_phrase(self):
        r = detect("I need a book. Can you please provide")
        assert r.intent == "vague_book_request"
        assert "product_phrase" not in r.entities

    def test_another_book_not_product_search(self):
        r = detect("I want another book.", _session())
        assert r.intent in ("another_book", "isbn_collection_start", "vague_book_request")

    def test_candidate_guard_blocks_generic(self):
        ok, reason = should_save_candidate("book_title_search", "book")
        assert not ok

    def test_explicit_title_allows(self):
        ok, _ = should_save_candidate("book_title_search", "Just Mercy")
        assert ok

    @pytest.mark.asyncio
    async def test_product_search_worker_blocks_generic(self):
        worker = ProductSearchWorker()
        with patch("app.tools.shopify_tools.search_products", new_callable=AsyncMock):
            r = await worker.run(
                _session(),
                {"intent": "book_title_search", "product_phrase": "I need a book"},
                None,
            )
        assert (r.data or {}).get("blocked") is True

    def test_save_blocked_for_generic(self):
        s = _session()
        item = save_product_candidate(
            s, title="Random", variant_id="gid://1",
            source_intent="book_title_search", source_query="I need a book",
        )
        assert item is None
