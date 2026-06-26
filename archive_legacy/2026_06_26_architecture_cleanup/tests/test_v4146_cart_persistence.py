"""v4.14.6 — Cart persistence tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.cart_orchestrator import add_candidate_to_cart
from app.agent_runtime.commerce_session import (
    ProductCandidate,
    cart_summary,
    clear_commerce_session,
    get_commerce_session,
    update_candidates_from_facts,
)


@pytest.fixture(autouse=True)
def _clean():
    clear_commerce_session("CA4146CP")
    yield
    clear_commerce_session("CA4146CP")


def _session_state():
    from app.state.models import SessionState

    return SessionState(
        session_id="sess4146cp",
        call_sid="CA4146CP",
        from_number="+15551234567",
        to_number="+15559876543",
    )


class TestCartPersistence:
    def test_candidate_with_variant_increments_cart(self):
        commerce = get_commerce_session("CA4146CP")
        update_candidates_from_facts(commerce, [
            ProductCandidate(
                candidate_id="ok1",
                product_id="p1",
                variant_id="v1",
                title="Dune",
                author=None,
                isbn="9780441172719",
                price="$12",
                currency="USD",
                availability="available",
                inventory_quantity=1,
                source="isbn",
                confidence=0.99,
            )
        ])
        state = _session_state()
        result = add_candidate_to_cart(commerce, "ok1", session_state=state)
        assert result["success"]
        assert cart_summary(commerce)["count"] == 1
        assert len(state.cart_items) == 1
        assert state.cart_items[0]["confirmation_status"] == "confirmed"

    def test_candidate_without_variant_blocked(self):
        commerce = get_commerce_session("CA4146CP")
        update_candidates_from_facts(commerce, [
            ProductCandidate(
                candidate_id="bad1",
                product_id="p1",
                variant_id=None,
                title="No Variant",
                author=None,
                isbn=None,
                price="$12",
                currency="USD",
                availability="available",
                inventory_quantity=1,
                source="search",
                confidence=0.9,
            )
        ])
        result = add_candidate_to_cart(commerce, "bad1")
        assert not result["success"]
        assert cart_summary(commerce)["count"] == 0
        assert "checkout option" in result["message"].lower()

    def test_cart_persists_across_turns(self):
        commerce = get_commerce_session("CA4146CP")
        update_candidates_from_facts(commerce, [
            ProductCandidate(
                candidate_id="b1",
                product_id="p1",
                variant_id="v1",
                title="Book One",
                author=None,
                isbn=None,
                price="$10",
                currency="USD",
                availability="available",
                inventory_quantity=1,
                source="search",
                confidence=0.9,
            )
        ])
        add_candidate_to_cart(commerce, "b1")
        reloaded = get_commerce_session("CA4146CP")
        assert cart_summary(reloaded)["count"] == 1
