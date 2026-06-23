"""v4.14.6 — CommerceCommitResolver tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.commerce_commit_resolver import resolve_commerce_commit
from app.agent_runtime.commerce_session import (
    ProductCandidate,
    cart_summary,
    clear_commerce_session,
    get_commerce_session,
    update_candidates_from_facts,
)
from app.agent_runtime.tool_entity_extractor import extract_tool_entities, is_commerce_control_phrase


@pytest.fixture(autouse=True)
def _clean():
    clear_commerce_session("CA4146CC")
    yield
    clear_commerce_session("CA4146CC")


def _seed(title: str = "When Scars Become Stories"):
    session = get_commerce_session("CA4146CC")
    update_candidates_from_facts(session, [
        ProductCandidate(
            candidate_id="c1",
            product_id="p1",
            variant_id="v1",
            title=title,
            author=None,
            isbn="9798893960648",
            price="$16.99",
            currency="USD",
            availability="available",
            inventory_quantity=5,
            source="isbn",
            confidence=0.99,
        )
    ])
    session.expected_next = "add_to_cart_offer"
    session.last_product_answer = f"I found {title}. Would you like me to add it to your order?"
    return session


class TestCommerceCommitResolver:
    def test_i_need_this_book_adds_to_cart(self):
        session = _seed()
        result = resolve_commerce_commit("I need this book.", session)
        assert result.matched
        assert "added" in (result.direct_answer or "").lower()
        assert cart_summary(session)["count"] == 1

    def test_yes_and_another_book(self):
        session = _seed()
        result = resolve_commerce_commit(
            "Yes. I need this 1, and I need another book.",
            session,
        )
        assert result.matched
        assert result.intent == "add_and_next_book"
        assert cart_summary(session)["count"] == 1
        assert result.expected_next in {"book_identifier", "isbn_number"}
        assert "next" in (result.direct_answer or "").lower()

    def test_add_it_and_another_isbn(self):
        session = _seed()
        result = resolve_commerce_commit("Add it and I need another ISBN.", session)
        assert result.matched
        assert cart_summary(session)["count"] == 1
        assert result.expected_next == "isbn_number"

    def test_multi_book_declaration(self):
        session = _seed()
        result = resolve_commerce_commit("I need these 2 books", session)
        assert result.matched
        assert result.intent == "multi_book_collection_start"
        assert session.multi_book_mode is True
        assert "first ISBN" in (result.direct_answer or "")

    def test_give_two_isbn_numbers(self):
        session = _seed()
        result = resolve_commerce_commit(
            "I give you the 2 ISBN numbers of 2 different books.",
            session,
        )
        assert result.matched
        assert result.intent == "multi_book_collection_start"
        assert session.multi_book_mode is True

    def test_control_phrase_not_title(self):
        assert is_commerce_control_phrase("Yes. I need this 1, and I need another book.")
        entities = extract_tool_entities("Yes. I need this 1, and I need another book.")
        assert "product_phrase" not in entities

    def test_pen_and_link_payment(self):
        session = _seed()
        result = resolve_commerce_commit("send me the pen and link of those books", session)
        assert result.matched
        assert result.intent == "payment_flow"
        assert "add them" in (result.direct_answer or "").lower() or "empty" in (result.direct_answer or "").lower()
