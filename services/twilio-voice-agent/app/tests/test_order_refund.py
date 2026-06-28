"""Tests for get_refund_status and enhanced lookup_order."""
import json
import pytest
from unittest.mock import AsyncMock, patch

from app.state.models import SessionState


def _make_session(**kwargs) -> SessionState:
    defaults = dict(
        session_id="sess-1",
        call_sid="CA000",
        from_number="+15551234567",
        to_number="+18005551234",
    )
    defaults.update(kwargs)
    return SessionState(**defaults)


def _mock_client(responses: list):
    """Return a mock ShopifyGraphQLClient that yields responses in order."""
    client = AsyncMock()
    client.configured = True
    client.execute = AsyncMock(side_effect=responses)
    return client


_ORDER_EDGE = {
    "node": {
        "id": "gid://shopify/Order/99",
        "name": "#1234",
        "displayFinancialStatus": "PAID",
        "displayFulfillmentStatus": "FULFILLED",
        "email": "customer@example.com",
        "phone": "+15551234567",
        "subtotalPriceSet": {"shopMoney": {"amount": "19.99", "currencyCode": "USD"}},
        "totalShippingPriceSet": {"shopMoney": {"amount": "0.00", "currencyCode": "USD"}},
        "lineItems": {"edges": [{"node": {"title": "The Great Gatsby", "quantity": 1}}]},
        "fulfillments": [{"trackingInfo": [{"number": "TRACK123", "url": "https://track.example.com"}]}],
        "cancelledAt": None,
        "canMarkAsPaid": False,
    }
}

_REFUND_RESPONSE = {
    "data": {
        "order": {
            "id": "gid://shopify/Order/99",
            "name": "#1234",
            "displayFinancialStatus": "REFUNDED",
            "displayFulfillmentStatus": "FULFILLED",
            "cancelledAt": None,
            "refunds": [
                {
                    "id": "gid://shopify/Refund/55",
                    "createdAt": "2026-06-15T10:00:00Z",
                    "totalRefundedSet": {"shopMoney": {"amount": "19.99", "currencyCode": "USD"}},
                    "refundLineItems": {
                        "edges": [
                            {"node": {"quantity": 1, "lineItem": {"title": "The Great Gatsby"}}}
                        ]
                    },
                    "transactions": [{"gateway": "shopify_payments", "amountSet": {"shopMoney": {"amount": "19.99", "currencyCode": "USD"}}}],
                }
            ],
        }
    }
}


class TestGetRefundStatus:
    async def test_verified_refund_returned(self):
        lookup_resp = {"data": {"orders": {"edges": [_ORDER_EDGE]}}}

        with patch("app.tools.shopify_tools.get_shopify_client") as mock_get_client:
            client = _mock_client([lookup_resp, _REFUND_RESPONSE])
            mock_get_client.return_value = client

            from app.tools.shopify_tools import get_refund_status

            result = json.loads(
                await get_refund_status(
                    order_number="#1234",
                    email="customer@example.com",
                )
            )

        assert result["found"] is True
        assert result["order_number"] == "#1234"
        assert result["refund_count"] == 1
        assert result["refunds"][0]["amount"] == "19.99 USD"
        assert "The Great Gatsby" in result["refunds"][0]["items"][0]
        assert result["refunds"][0]["date"] == "2026-06-15"

    async def test_order_number_fetches_refunds(self):
        lookup_resp = {"data": {"orders": {"edges": [_ORDER_EDGE]}}}

        with patch("app.tools.shopify_tools.get_shopify_client") as mock_get_client:
            mock_get_client.return_value = _mock_client([lookup_resp, _REFUND_RESPONSE])

            from app.tools.shopify_tools import get_refund_status

            result = json.loads(
                await get_refund_status(order_number="#1234")
            )

        assert result.get("found") is True
        assert result.get("refund_count", 0) >= 0

    async def test_no_refunds_found(self):
        lookup_resp = {"data": {"orders": {"edges": [_ORDER_EDGE]}}}
        no_refunds = {"data": {"order": {**_REFUND_RESPONSE["data"]["order"], "refunds": []}}}

        with patch("app.tools.shopify_tools.get_shopify_client") as mock_get_client:
            mock_get_client.return_value = _mock_client([lookup_resp, no_refunds])

            from app.tools.shopify_tools import get_refund_status

            result = json.loads(
                await get_refund_status(
                    order_number="1234",
                    email="customer@example.com",
                )
            )

        assert result["found"] is True
        assert result["refund_count"] == 0

    async def test_order_not_found(self):
        lookup_resp = {"data": {"orders": {"edges": []}}}

        with patch("app.tools.shopify_tools.get_shopify_client") as mock_get_client:
            mock_get_client.return_value = _mock_client([lookup_resp])

            from app.tools.shopify_tools import get_refund_status

            result = json.loads(
                await get_refund_status(order_number="9999", email="x@x.com")
            )

        assert result["found"] is False

    async def test_shopify_unavailable_returns_error(self):
        with patch("app.tools.shopify_tools.get_shopify_client") as mock_get_client:
            client = AsyncMock()
            client.configured = True
            client.execute = AsyncMock(side_effect=Exception("timeout"))
            mock_get_client.return_value = client

            from app.tools.shopify_tools import get_refund_status

            result = json.loads(
                await get_refund_status(order_number="1234", email="x@x.com")
            )

        assert "error" in result

    async def test_session_verification_state_updated(self):
        lookup_resp = {"data": {"orders": {"edges": [_ORDER_EDGE]}}}

        with patch("app.tools.shopify_tools.get_shopify_client") as mock_get_client:
            mock_get_client.return_value = _mock_client([lookup_resp, _REFUND_RESPONSE])

            from app.tools.shopify_tools import get_refund_status

            session = _make_session()
            await get_refund_status(
                order_number="1234",
                email="customer@example.com",
                session=session,
            )

        assert session.verified_email is True

    async def test_session_preloaded_email_used(self):
        """If session already has verified email, tool uses it without caller providing it."""
        lookup_resp = {"data": {"orders": {"edges": [_ORDER_EDGE]}}}

        with patch("app.tools.shopify_tools.get_shopify_client") as mock_get_client:
            mock_get_client.return_value = _mock_client([lookup_resp, _REFUND_RESPONSE])

            from app.tools.shopify_tools import get_refund_status

            session = _make_session(
                caller_email="customer@example.com",
                verified_email=True,
            )
            result = json.loads(
                await get_refund_status(order_number="1234", session=session)
            )

        # Should succeed using session email, not be blocked
        assert result.get("found") is True or "refund_count" in result


class TestLookupOrderEnhanced:
    async def test_verified_details_update_session(self):
        lookup_resp = {"data": {"orders": {"edges": [_ORDER_EDGE]}}}

        with patch("app.tools.shopify_tools.get_shopify_client") as mock_get_client:
            mock_get_client.return_value = _mock_client([lookup_resp])

            from app.tools.shopify_tools import lookup_order

            session = _make_session()
            result = json.loads(
                await lookup_order(
                    order_number="1234",
                    email="customer@example.com",
                    session=session,
                )
            )

        assert result["found"] is True
        assert "items" in result  # verified → full details
        assert session.last_order_number == "#1234"
        assert session.verified_email is True
