"""v4.14.9 — Candidate selection tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.cart_orchestrator import cart_summary_text
from app.agent_runtime.commerce_commit_resolver import resolve_commerce_commit
from app.agent_runtime.commerce_session import (
    ProductCandidate,
    add_selected_candidate_to_cart,
    clear_commerce_session,
    get_commerce_session,
    update_candidates_from_facts,
)


@pytest.fixture(autouse=True)
def _clean():
    clear_commerce_session("CA4149CS")
    yield
    clear_commerce_session("CA4149CS")


def _setup_candidates(session):
    update_candidates_from_facts(session, [
        ProductCandidate(
            candidate_id="c1", product_id="p1", variant_id="v1", title="First Book",
            author=None, isbn=None, price="$10", currency="USD",
            availability="available", inventory_quantity=1, source="search", confidence=0.9,
            product_kind="book",
        ),
        ProductCandidate(
            candidate_id="c2", product_id="p2", variant_id="v2", title="USA Today 5 Day",
            author=None, isbn=None, price="$25", currency="USD",
            availability="available", inventory_quantity=1, source="search", confidence=0.9,
            product_kind="newspaper",
        ),
        ProductCandidate(
            candidate_id="c3", product_id="p3", variant_id="v3", title="People Magazine 6 Mo",
            author=None, isbn=None, price="$18", currency="USD",
            availability="available", inventory_quantity=1, source="search", confidence=0.9,
            product_kind="magazine",
        ),
    ])


class TestCandidateSelection:
    def test_add_first_one(self):
        session = get_commerce_session("CA4149CS")
        _setup_candidates(session)
        session.expected_next = "confirm_add"
        result = resolve_commerce_commit("Add the first one.", session)
        assert result.matched
        active = [ln for ln in session.active_cart if ln.status == "active"]
        assert len(active) >= 1

    def test_add_second_one(self):
        session = get_commerce_session("CA4149CS")
        _setup_candidates(session)
        result = resolve_commerce_commit("Add the second one.", session)
        assert result.matched

    def test_add_both(self):
        session = get_commerce_session("CA4149CS")
        _setup_candidates(session)
        result = resolve_commerce_commit("Add both.", session)
        assert result.matched
        assert result.intent in ("add_all_candidates", "add_both")

    def test_add_all(self):
        session = get_commerce_session("CA4149CS")
        _setup_candidates(session)
        result = resolve_commerce_commit("Add all.", session)
        assert result.matched

    def test_remove_second(self):
        session = get_commerce_session("CA4149CS")
        _setup_candidates(session)
        for cid in ("c1", "c2"):
            session.selected_candidate_id = cid
            add_selected_candidate_to_cart(session)
        result = resolve_commerce_commit("Remove the second one.", session)
        assert result.matched
        active = [ln for ln in session.active_cart if ln.status == "active"]
        assert len(active) == 1

    def test_cart_summary_uses_items_for_mixed(self):
        session = get_commerce_session("CA4149CS")
        _setup_candidates(session)
        for cid in ("c1", "c2", "c3"):
            session.selected_candidate_id = cid
            add_selected_candidate_to_cart(session)
        summary = cart_summary_text(session)
        assert "3 items" in summary
        assert "books" not in summary.split("in your order")[0].split()[-1:]

    def test_cart_summary_uses_books_when_all_books(self):
        session = get_commerce_session("CA4149CS")
        update_candidates_from_facts(session, [
            ProductCandidate(
                candidate_id="b1", product_id="p1", variant_id="v1", title="Book A",
                author=None, isbn=None, price="$10", currency="USD",
                availability="available", inventory_quantity=1, source="search", confidence=0.9,
                product_kind="book",
            ),
            ProductCandidate(
                candidate_id="b2", product_id="p2", variant_id="v2", title="Book B",
                author=None, isbn=None, price="$12", currency="USD",
                availability="available", inventory_quantity=1, source="search", confidence=0.9,
                product_kind="book",
            ),
        ])
        for cid in ("b1", "b2"):
            session.selected_candidate_id = cid
            add_selected_candidate_to_cart(session)
        summary = cart_summary_text(session)
        assert "2 books" in summary

    def test_what_did_i_add(self):
        session = get_commerce_session("CA4149CS")
        _setup_candidates(session)
        session.selected_candidate_id = "c1"
        add_selected_candidate_to_cart(session)
        result = resolve_commerce_commit("What did I add?", session)
        assert result.matched
        assert "First Book" in (result.direct_answer or "")

    def test_cart_line_has_extended_fields(self):
        session = get_commerce_session("CA4149CS")
        _setup_candidates(session)
        session.selected_candidate_id = "c1"
        line = add_selected_candidate_to_cart(session)
        assert line.product_kind == "book"
        assert line.source_identifier
        assert line.orderability_status == "orderable"
