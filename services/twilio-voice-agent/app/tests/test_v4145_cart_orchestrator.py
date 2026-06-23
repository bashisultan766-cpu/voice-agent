"""v4.14.5 — Cart orchestrator tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.cart_orchestrator import (
    add_candidate_to_cart,
    cart_count,
    cart_summary_text,
    remove_cart_item,
)
from app.agent_runtime.commerce_session import (
    ProductCandidate,
    clear_commerce_session,
    get_commerce_session,
    update_candidates_from_facts,
)


def _session_with_book():
    clear_commerce_session("CA4145C")
    session = get_commerce_session("CA4145C")
    update_candidates_from_facts(session, [
        ProductCandidate(
            candidate_id="b1",
            product_id="p1",
            variant_id="v1",
            title="Book A",
            author=None,
            isbn=None,
            price="$10.00",
            currency="USD",
            availability="available",
            inventory_quantity=1,
            source="search",
            confidence=0.9,
        ),
        ProductCandidate(
            candidate_id="b2",
            product_id="p2",
            variant_id="v2",
            title="Book B",
            author=None,
            isbn=None,
            price="$12.00",
            currency="USD",
            availability="available",
            inventory_quantity=1,
            source="search",
            confidence=0.85,
        ),
    ])
    return session


class TestCartOrchestrator:
    def test_add_and_count(self):
        session = _session_with_book()
        add_candidate_to_cart(session, "b1")
        add_candidate_to_cart(session, "b2")
        assert cart_count(session) == 2

    def test_cart_summary(self):
        session = _session_with_book()
        add_candidate_to_cart(session, "b1")
        summary = cart_summary_text(session)
        assert "Book A" in summary
        assert "before shipping" in summary

    def test_remove(self):
        session = _session_with_book()
        add_candidate_to_cart(session, "b1")
        result = remove_cart_item(session)
        assert result["success"]
        assert cart_count(session) == 0

    def test_cart_count_question(self):
        session = _session_with_book()
        add_candidate_to_cart(session, "b1")
        assert cart_count(session) == 1
