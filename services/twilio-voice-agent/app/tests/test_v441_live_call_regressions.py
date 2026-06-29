"""v4.41 — regressions from live call CA4d6b (ISBN buffer, add_to_cart gate, order lookup)."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent_runtime.commerce_flow_state import (
    COMMERCE_FLOW_VERSION,
    advance_commerce_state_silent,
    commerce_add_to_cart_allowed,
    gate_add_to_cart,
    stage_product_candidate,
    STATUS_AWAITING_ADD_CONFIRM,
    STATUS_AWAITING_QUANTITY,
)
from app.agent_runtime.isbn_short_circuit import (
    ISBN_SHORT_CIRCUIT_VERSION,
    prepare_isbn_turn_context,
    should_skip_isbn_digit_collection,
)
from app.agent_runtime.order_flow_state import (
    ORDER_FLOW_VERSION,
    prepare_order_turn_context,
)
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="v441",
        call_sid="CA4d6b46a62b63d212e99f751242746139",
        from_number="+1",
        to_number="+2",
    )
    base.update(kwargs)
    return SessionState(**base)


class TestVersions:
    def test_versions(self):
        assert ISBN_SHORT_CIRCUIT_VERSION == "v4.44"
        assert COMMERCE_FLOW_VERSION == "v4.50"
        assert ORDER_FLOW_VERSION == "v4.50"


class TestIsbnSkipGuards:
    def test_one_copy_does_not_buffer_isbn(self):
        session = _session(
            commerce_flow_status=STATUS_AWAITING_QUANTITY,
            commerce_pending_candidate={
                "title": "A Feast for Crows",
                "variant_id": "v1",
                "isbn": "9780553582024",
            },
        )
        assert should_skip_isbn_digit_collection(session, "Yeah. I need 1 copy.")
        isbn = prepare_isbn_turn_context(session, "Yeah. I need 1 copy.")
        assert isbn is None
        assert getattr(session, "pending_isbn_buffer", "") == ""

    def test_order_number_speech_skips_isbn_buffer(self):
        session = _session()
        assert should_skip_isbn_digit_collection(
            session, "The order number is 4 7 9 0 7."
        )
        prepare_isbn_turn_context(session, "The order number is 4 7 9 0 7.")
        assert getattr(session, "pending_isbn_buffer", "") == ""


class TestCommerceSilentAdvance:
    def test_quantity_then_yes_unlocks_add_to_cart(self):
        session = _session()
        stage_product_candidate(
            session,
            {
                "title": "A Feast for Crows",
                "variant_id": "v1",
                "isbn": "9780553582024",
                "price": "10.99",
            },
        )
        assert session.commerce_flow_status == STATUS_AWAITING_QUANTITY
        assert not commerce_add_to_cart_allowed(session)

        advance_commerce_state_silent(session, "Yeah. I need 1 copy.")
        assert session.commerce_flow_status == STATUS_AWAITING_ADD_CONFIRM
        assert session.commerce_pending_quantity == 1
        assert session.commerce_allow_add is True
        assert commerce_add_to_cart_allowed(session)
        assert gate_add_to_cart(session) is None

        advance_commerce_state_silent(session, "Yes.")
        assert session.commerce_allow_add is True
        assert gate_add_to_cart(session) is None


class TestOrderContext:
    def test_prepare_order_clears_isbn_buffer(self):
        session = _session()
        session.pending_isbn_buffer = "47907"
        prepare_order_turn_context(session, "The order number is 4 7 9 0 7.")
        assert session.last_order_number == "47907"
        assert getattr(session, "pending_isbn_buffer", "") == ""


class TestLookupOrderLineItems:
    @pytest.mark.asyncio
    async def test_order_number_only_includes_items_and_total(self):
        from app.tools import shopify_tools as st

        node = {
            "name": "#47905",
            "displayFinancialStatus": "PAID",
            "displayFulfillmentStatus": "UNFULFILLED",
            "lineItems": {
                "edges": [
                    {"node": {"quantity": 1, "title": "A Feast for Crows"}},
                ]
            },
            "subtotalPriceSet": {"shopMoney": {"amount": "10.99", "currencyCode": "USD"}},
            "totalShippingPriceSet": {"shopMoney": {"amount": "4.99", "currencyCode": "USD"}},
            "totalPriceSet": {"shopMoney": {"amount": "15.98", "currencyCode": "USD"}},
            "email": "",
            "customer": {},
            "transactions": [],
            "fulfillments": [],
        }

        client = MagicMock()
        client.configured = True
        client.execute = AsyncMock(
            return_value={"data": {"orders": {"edges": [{"node": node}]}}}
        )

        with patch.object(st, "get_shopify_client", return_value=client):
            raw = await st.lookup_order(order_number="47905")
        payload = json.loads(raw)
        assert payload["found"] is True
        assert payload.get("items")
        assert payload.get("total")
        assert payload.get("verification_required") is False
        assert "verify" not in payload.get("suggested_response", "").lower()
