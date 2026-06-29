"""v4.44 — CA3b89 regressions: quantity unlocks add_to_cart, price variant pick."""
from __future__ import annotations

from app.agent_runtime.commerce_flow_state import (
    COMMERCE_FLOW_VERSION,
    STATUS_AWAITING_ADD_CONFIRM,
    STATUS_AWAITING_QUANTITY,
    advance_commerce_state_silent,
    commerce_add_to_cart_allowed,
    gate_add_to_cart,
    maybe_stage_from_search_payload,
    stage_product_candidate,
)
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="v444",
        call_sid="CA3b897c60d9eadba11055dd0c5379dd97",
        from_number="+1",
        to_number="+2",
    )
    base.update(kwargs)
    return SessionState(**base)


BOOK_A = {
    "title": "BRAND YOU! Master Your Social Media",
    "variant_id": "v-brand",
    "isbn": "9780988752894",
    "price": "7.43",
}

GOT_CHEAP = {
    "title": "A Game of Thrones",
    "variant_id": "v-got-999",
    "isbn": "9780553573404",
    "price": "9.99",
}

GOT_EXPENSIVE = {
    "title": "A Game of Thrones",
    "variant_id": "v-got-1100",
    "isbn": "9780553573404",
    "price": "11.00",
}


class TestV444:
    def test_version(self):
        assert COMMERCE_FLOW_VERSION == "v4.53"

    def test_just_one_cup_unlocks_add_without_yes(self):
        """STT 'cup' for 'copy' — quantity alone must not gate add_to_cart."""
        session = _session()
        stage_product_candidate(session, BOOK_A)
        advance_commerce_state_silent(session, "Just 1 cup.")
        assert session.commerce_pending_quantity == 1
        assert session.commerce_allow_add is True
        assert commerce_add_to_cart_allowed(session)
        assert gate_add_to_cart(session) is None

    def test_three_copies_unlocks_add(self):
        session = _session()
        stage_product_candidate(session, GOT_EXPENSIVE)
        advance_commerce_state_silent(session, "Just 3 copy of that.")
        assert session.commerce_pending_quantity == 3
        assert session.commerce_allow_add is True
        assert gate_add_to_cart(session) is None

    def test_price_pick_restage_variant(self):
        session = _session()
        maybe_stage_from_search_payload(
            session,
            {"results": [GOT_CHEAP, GOT_EXPENSIVE], "count": 2},
        )
        assert session.commerce_pending_candidate["price"] == "9.99"
        advance_commerce_state_silent(session, "The 11 dollars.")
        assert session.commerce_pending_candidate["variant_id"] == "v-got-1100"
        assert session.commerce_pending_candidate["price"] == "11.00"
        assert session.commerce_flow_status == STATUS_AWAITING_QUANTITY

    def test_price_then_quantity_unlocks_add(self):
        session = _session()
        session.commerce_last_catalog_results = [GOT_CHEAP, GOT_EXPENSIVE]
        stage_product_candidate(session, GOT_CHEAP)
        advance_commerce_state_silent(session, "The 11 dollars.")
        advance_commerce_state_silent(session, "Just 3 copy of that.")
        assert session.commerce_pending_quantity == 3
        assert session.commerce_allow_add is True
        assert session.commerce_flow_status == STATUS_AWAITING_ADD_CONFIRM
        assert gate_add_to_cart(session) is None
