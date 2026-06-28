"""
Order lookup full disclosure — email, refunds, pricing, notes, privacy (v4.52).
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from app.shopify.order_privacy import (
    card_brand_from_transactions,
    card_last4_from_transactions,
    is_order_disclosure_verified,
    mask_email_for_voice,
    sanitize_order_object,
)
from app.state.models import SessionState
from app.tools.shopify_tools import (
    _build_full_order_from_node,
    _format_order_customer_message,
    lookup_shopify_order_details,
)

_FULL_ORDER_NODE = {
    "id": "gid://shopify/Order/99",
    "name": "#22318",
    "createdAt": "2022-05-20T10:00:00Z",
    "displayFinancialStatus": "REFUNDED",
    "displayFulfillmentStatus": "FULFILLED",
    "email": "john.smith@gmail.com",
    "phone": "+15550001111",
    "customer": {
        "firstName": "John",
        "lastName": "Smith",
        "email": "john.smith@gmail.com",
        "numberOfOrders": 3,
    },
    "subtotalPriceSet": {"shopMoney": {"amount": "25.00", "currencyCode": "USD"}},
    "totalShippingPriceSet": {"shopMoney": {"amount": "0.00", "currencyCode": "USD"}},
    "totalTaxSet": {"shopMoney": {"amount": "2.00", "currencyCode": "USD"}},
    "totalDiscountsSet": {"shopMoney": {"amount": "1.00", "currencyCode": "USD"}},
    "totalPriceSet": {"shopMoney": {"amount": "26.00", "currencyCode": "USD"}},
    "lineItems": {
        "edges": [{
            "node": {
                "title": "Book A",
                "quantity": 2,
                "sku": "BA-1",
                "originalUnitPriceSet": {"shopMoney": {"amount": "12.50", "currencyCode": "USD"}},
                "variant": {"barcode": "9780000000001", "sku": "BA-1"},
            }
        }]
    },
    "fulfillments": [{
        "status": "SUCCESS",
        "trackingInfo": [{"company": "USPS", "number": "9400111111", "url": "https://track.example.com"}],
    }],
    "refunds": [{
        "createdAt": "2022-05-25T12:58:00Z",
        "note": "Customer request",
        "totalRefundedSet": {"shopMoney": {"amount": "26.00", "currencyCode": "USD"}},
        "refundLineItems": {
            "edges": [{"node": {"quantity": 2, "lineItem": {"title": "Book A"}}}]
        },
        "transactions": {
            "edges": [{"node": {"paymentDetails": {"number": "****1234", "company": "Visa"}}}]
        },
    }],
    "transactions": [{"paymentDetails": {"number": "****5678", "company": "Visa"}}],
    "note": "Ship media mail only",
    "customAttributes": [{"key": "inmate_id", "value": "A123"}],
}


@pytest.fixture(autouse=True)
def _no_timeline(monkeypatch):
    async def _empty(*_a, **_k):
        return []

    monkeypatch.setattr("app.tools.shopify_tools._fetch_order_timeline", _empty)


def _order_mock():
    client = AsyncMock()
    client.configured = True
    client.execute = AsyncMock(
        return_value={"data": {"orders": {"edges": [{"node": _FULL_ORDER_NODE}]}}}
    )
    return client


class TestVerifiedFullDisclosure:
    def test_verified_order_number_implies_disclosure(self):
        assert is_order_disclosure_verified(
            None, order_number_provided=True, order_email="john.smith@gmail.com",
        )

    def test_verified_response_includes_full_customer_email(self):
        order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
        msg = _format_order_customer_message(order, order_email="john.smith@gmail.com", verified=True)
        assert "john.smith@gmail.com" in msg
        assert "j***@" not in msg

    def test_verified_response_includes_customer_name(self):
        order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
        msg = _format_order_customer_message(order, order_email="john.smith@gmail.com", verified=True)
        assert "John Smith" in msg

    def test_refund_includes_full_destination_email(self):
        order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
        msg = _format_order_customer_message(order, order_email="john.smith@gmail.com", verified=True)
        assert "refund was sent to john.smith@gmail.com" in msg.lower()

    def test_refund_includes_amount_and_date(self):
        order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
        msg = _format_order_customer_message(order, order_email="john.smith@gmail.com", verified=True)
        assert "26.00" in msg
        assert "2022-05-25" in msg

    def test_card_only_last4_never_full_pan(self):
        order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
        msg = _format_order_customer_message(order, order_email="john.smith@gmail.com", verified=True)
        assert "1234" in msg
        assert "****1234" not in msg
        assert "5678" not in msg or "ending in 5678" not in msg  # payment card not primary on refund
        assert "4111111111111111" not in msg

    def test_items_title_and_quantity(self):
        order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
        assert order["items"][0]["title"] == "Book A"
        assert order["items"][0]["quantity"] == 2
        msg = _format_order_customer_message(order, order_email="john.smith@gmail.com", verified=True)
        assert "Book A" in msg

    def test_pricing_fields(self):
        order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
        pricing = order["pricing"]
        assert pricing["subtotal"]
        assert pricing["shipping"]
        assert pricing["tax"]
        assert pricing["discount"]
        assert pricing["total"]

    def test_tracking_carrier_and_number(self):
        order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
        assert order["tracking"]["carrier"] == "USPS"
        assert order["tracking"]["tracking_number"] == "9400111111"
        msg = _format_order_customer_message(order, order_email="john.smith@gmail.com", verified=True)
        assert "USPS" in msg
        assert "9400111111" in msg

    def test_shopify_notes_included(self):
        order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
        assert order["notes"] == "Ship media mail only"
        msg = _format_order_customer_message(order, order_email="john.smith@gmail.com", verified=True)
        assert "Ship media mail only" in msg

    def test_note_attributes_included(self):
        order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
        assert order["note_attributes"]["inmate_id"] == "A123"
        msg = _format_order_customer_message(order, order_email="john.smith@gmail.com", verified=True)
        assert "inmate_id" in msg


class TestUnverifiedPrivacy:
    def test_unverified_masks_email_in_order_object(self):
        order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
        sanitized = sanitize_order_object(order, verified=False)
        assert sanitized["customer_email"] == mask_email_for_voice("john.smith@gmail.com")
        assert "john.smith" not in sanitized["customer_email"]

    def test_unverified_spoken_message_masks_email(self):
        order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
        sanitized = sanitize_order_object(order, verified=False)
        msg = _format_order_customer_message(
            sanitized,
            order_email=sanitized["customer_email"],
            verified=False,
        )
        assert "john.smith@gmail.com" not in msg
        assert "j***@gmail.com" in msg

    def test_unverified_strips_card_last4(self):
        order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
        sanitized = sanitize_order_object(order, verified=False)
        assert sanitized["payment_card_last4"] == ""
        assert sanitized["refunds"][0]["card_last4"] == ""


class TestLookupToolIntegration:
    @pytest.mark.asyncio
    async def test_lookup_returns_canonical_order_and_customer_message(self):
        with patch("app.tools.shopify_tools.get_shopify_client", return_value=_order_mock()):
            with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
                with patch("app.tools.shopify_tools.shopify_cache_set", AsyncMock()):
                    raw = await lookup_shopify_order_details("22318")
        data = json.loads(raw)
        assert data["found"] is True
        assert data["verification_required"] is False
        order = data["order"]
        assert order["customer_email"] == "john.smith@gmail.com"
        assert order["customer_name"] == "John Smith"
        assert "john.smith@gmail.com" in data["customer_message"]

    @pytest.mark.asyncio
    async def test_missing_fields_do_not_hallucinate(self):
        node = {**_FULL_ORDER_NODE, "fulfillments": [], "refunds": [], "displayFinancialStatus": "PAID"}
        client = AsyncMock()
        client.configured = True
        client.execute = AsyncMock(
            return_value={"data": {"orders": {"edges": [{"node": node}]}}}
        )
        with patch("app.tools.shopify_tools.get_shopify_client", return_value=client):
            with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
                with patch("app.tools.shopify_tools.shopify_cache_set", AsyncMock()):
                    raw = await lookup_shopify_order_details("22318")
        data = json.loads(raw)
        assert "do not see a refund" in data["customer_message"].lower()
        assert "4111111111111111" not in data["customer_message"]


class TestCardPrivacyHelpers:
    def test_card_brand_from_transactions(self):
        txns = [{"paymentDetails": {"number": "****1234", "company": "Visa"}}]
        assert card_brand_from_transactions(txns) == "Visa"
        assert card_last4_from_transactions(txns) == "1234"


@pytest.mark.asyncio
async def test_main_brain_uses_order_lookup_customer_message():
    from app.agents.main_commerce_brain import MainCommerceBrain
    from app.agent_runtime import llm_tools
    from app.tests.test_isbn_and_order_lookup_fix import (
        _FakeClient,
        _tool_response,
        _text_response,
    )

    brain = MainCommerceBrain()
    customer_msg = "That order is under John Smith. Your refund was sent to john.smith@gmail.com."
    brain._client = _FakeClient([
        _tool_response("lookup_shopify_order_details", {"order_number": "22318"}),
        _text_response(customer_msg),
    ])
    session = SessionState(
        session_id="s1", call_sid="CA1", from_number="+15551230000", to_number="+15559999999",
    )

    async def fake_dispatch(name, args, session):
        return json.dumps({
            "found": True,
            "customer_message": customer_msg,
            "order": {"customer_name": "John Smith"},
        })

    with patch.object(llm_tools, "dispatch", side_effect=fake_dispatch):
        text, tools, _ = await brain.run_turn(session, "status of order 22318")

    assert "lookup_shopify_order_details" in tools
    assert "john.smith@gmail.com" in text or "John Smith" in text
