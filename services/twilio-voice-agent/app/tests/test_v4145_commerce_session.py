"""v4.14.5 — CommerceSession tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.commerce_session import (
    CommerceSession,
    ProductCandidate,
    add_selected_candidate_to_cart,
    clear_commerce_session,
    get_commerce_session,
    get_last_selected_or_best_candidate,
    remove_cart_line,
    update_candidates_from_facts,
)


@pytest.fixture(autouse=True)
def _clean():
    clear_commerce_session("CA4145")
    yield
    clear_commerce_session("CA4145")


def _candidate(**kwargs) -> ProductCandidate:
    defaults = dict(
        candidate_id="c1",
        product_id="p1",
        variant_id="v1",
        title="The Grandparenting Blueprint",
        author=None,
        isbn="9798893960648",
        price="$19.99",
        currency="USD",
        availability="available",
        inventory_quantity=5,
        source="isbn",
        confidence=0.99,
    )
    defaults.update(kwargs)
    return ProductCandidate(**defaults)


class TestCommerceSession:
    def test_get_and_update_candidates(self):
        session = get_commerce_session("CA4145")
        update_candidates_from_facts(session, [_candidate()])
        assert len(session.last_candidates) == 1
        assert session.selected_candidate_id == "c1"

    def test_add_selected_to_cart(self):
        session = get_commerce_session("CA4145")
        update_candidates_from_facts(session, [_candidate()])
        line = add_selected_candidate_to_cart(session)
        assert line is not None
        assert line.title == "The Grandparenting Blueprint"
        assert line.variant_id == "v1"

    def test_remove_cart_line(self):
        session = get_commerce_session("CA4145")
        update_candidates_from_facts(session, [_candidate()])
        line = add_selected_candidate_to_cart(session)
        removed = remove_cart_line(session, line_id=line.line_id)
        assert removed is not None
        assert removed.status == "removed"

    def test_get_last_selected_or_best(self):
        session = get_commerce_session("CA4145")
        update_candidates_from_facts(session, [_candidate()])
        best = get_last_selected_or_best_candidate(session)
        assert best is not None
        assert best.isbn == "9798893960648"
