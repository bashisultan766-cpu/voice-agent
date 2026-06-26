"""v4.14.6 — MultiBookCollector tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.commerce_commit_resolver import resolve_commerce_commit
from app.agent_runtime.commerce_session import clear_commerce_session, get_commerce_session
from app.agent_runtime.multi_book_collector import enter_multi_book_mode, handle_multi_book_turn
from app.agent_runtime.tool_entity_extractor import extract_all_isbns


@pytest.fixture(autouse=True)
def _clean():
    clear_commerce_session("CA4146MB")
    yield
    clear_commerce_session("CA4146MB")


class TestMultiBookCollector:
    def test_enter_multi_book_mode(self):
        session = get_commerce_session("CA4146MB")
        msg = enter_multi_book_mode(session, requested_count=2)
        assert session.multi_book_mode is True
        assert session.requested_cart_count == 2
        assert "first ISBN" in msg

    def test_partial_isbn_no_search(self):
        session = get_commerce_session("CA4146MB")
        enter_multi_book_mode(session)
        result = handle_multi_book_turn("9 7 9 8", session)
        assert result.matched
        assert result.intent == "isbn_partial"
        assert result.response_mode == "direct_answer"
        assert "continue" in (result.direct_answer or "").lower()
        assert result.tool_categories is None or result.tool_categories == []

    def test_complete_isbn_triggers_search(self):
        session = get_commerce_session("CA4146MB")
        enter_multi_book_mode(session)
        result = handle_multi_book_turn("ISBN is 9798893960648", session)
        assert result.matched
        assert result.response_mode == "needs_tools"
        assert "isbn_lookup" in (result.tool_categories or [])

    def test_two_isbns_in_utterance(self):
        text = "The ISBNs are 9798893960648 and 9780441172719"
        isbns = extract_all_isbns(text)
        assert len(isbns) == 2
        session = get_commerce_session("CA4146MB")
        result = resolve_commerce_commit(text, session)
        assert result.matched
        assert len(session.collected_identifiers) >= 2
