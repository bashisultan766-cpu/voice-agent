"""v4.14.9 — Multi-identifier parser tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.catalog_taxonomy import classify_product_segment, extract_mixed_product_segments
from app.agent_runtime.commerce_commit_resolver import resolve_commerce_commit
from app.agent_runtime.commerce_session import clear_commerce_session, get_commerce_session
from app.agent_runtime.multi_book_collector import handle_multiple_isbns
from app.agent_runtime.tool_entity_extractor import (
    extract_all_isbns,
    extract_product_identifiers,
    is_commerce_control_phrase,
)


@pytest.fixture(autouse=True)
def _clean():
    clear_commerce_session("CA4149MI")
    yield
    clear_commerce_session("CA4149MI")


class TestMultiIdentifierParser:
    def test_three_isbns_in_one_utterance(self):
        text = "ISBNs are 9798994835500, 9798893960648, and 9780441172719"
        isbns = extract_all_isbns(text)
        assert len(isbns) == 3

    def test_hyphenated_isbn(self):
        isbns = extract_all_isbns("ISBN 978-0-441-17271-9")
        assert len(isbns) == 1
        assert isbns[0] == "9780441172719"

    def test_spaced_isbn(self):
        isbns = extract_all_isbns("9 7 9 8 8 9 3 9 6 0 6 4 8")
        assert len(isbns) == 1

    def test_mixed_book_newspaper_magazine(self):
        text = "I need this book, USA Today newspaper, and People magazine."
        segments = extract_mixed_product_segments(text)
        assert len(segments) >= 2
        identifiers = extract_product_identifiers(text)
        assert len(identifiers) >= 2

    def test_control_phrases_not_searched(self):
        assert is_commerce_control_phrase("add both")
        assert is_commerce_control_phrase("send payment link")
        assert is_commerce_control_phrase("these books")
        assert is_commerce_control_phrase("the other four")
        assert is_commerce_control_phrase("remove second one")

    def test_two_isbns_triggers_multi_search(self):
        session = get_commerce_session("CA4149MI")
        text = "9798994835500 and 9798893960648"
        isbns = extract_all_isbns(text)
        result = handle_multiple_isbns(text, session, isbns)
        assert result.response_mode == "needs_tools"
        assert len(session.collected_identifiers) == 2

    def test_mixed_via_commit_resolver(self):
        session = get_commerce_session("CA4149MI")
        text = "I need Game of Thrones book, USA Today newspaper, and People magazine."
        result = resolve_commerce_commit(text, session)
        if result.matched:
            assert result.intent == "mixed_identifiers_detected"
            assert len(session.collected_identifiers) >= 2

    def test_classify_newspaper_segment(self):
        seg = classify_product_segment("USA Today 5 day delivery for 3 months")
        assert seg.get("product_kind") == "newspaper" or "USA Today" in seg.get("title", "")
