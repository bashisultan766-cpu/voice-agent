"""v4.56 — no catalog search without explicit title or ISBN."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from app.agent_runtime.isbn_short_circuit import (
    is_explicit_title_catalog_query,
    looks_like_book_title_request,
    try_title_catalog_short_circuit,
)
from app.agent_runtime.workflow_isolation import product_handling_allowed
from app.runtime.fast_classifier import classify
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="s",
        call_sid="CA_GATE",
        from_number="+1",
        to_number="+2",
    )
    base.update(kwargs)
    return SessionState(**base)


class TestNoAutoProductSearch:
    def test_bare_title_words_do_not_trigger(self):
        assert not is_explicit_title_catalog_query("Gurdwara")
        assert not is_explicit_title_catalog_query("Red River Vengeance")
        assert not is_explicit_title_catalog_query("Atomic Habits")
        assert not looks_like_book_title_request("hello how are you")

    def test_vague_book_request_does_not_trigger(self):
        assert not is_explicit_title_catalog_query("I need a book")
        assert not is_explicit_title_catalog_query("I want to buy a book")

    def test_explicit_title_triggers(self):
        assert is_explicit_title_catalog_query("Do you have Red River Vengeance")
        assert is_explicit_title_catalog_query("I'm looking for Gurdwara")
        assert is_explicit_title_catalog_query("The book title is Atomic Habits")

    def test_product_handling_blocked_without_title(self):
        session = _session()
        assert not product_handling_allowed(session, "", "hello there")
        assert not product_handling_allowed(session, "", "Red River Vengeance")
        assert product_handling_allowed(
            session, "", "Do you have Red River Vengeance",
        )

    def test_classifier_does_not_mark_casual_speech_as_product_search(self):
        session = _session()
        result = classify("how are you doing today", session)
        assert not result.is_product_search

    def test_classifier_does_not_search_on_book_title_mention_alone(self):
        session = _session()
        result = classify("Game of Thrones", session)
        assert not result.is_product_search


@pytest.mark.asyncio
async def test_title_catalog_not_called_without_explicit_title():
    session = _session()
    catalog = AsyncMock(return_value=json.dumps({"results": [], "count": 0}))

    with patch("app.agent_runtime.llm_tools._catalog_search", catalog):
        assert await try_title_catalog_short_circuit(session, "Gurdwara") is None
        assert await try_title_catalog_short_circuit(session, "hello") is None
        catalog.assert_not_called()
