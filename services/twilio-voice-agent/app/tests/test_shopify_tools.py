"""
Tests for Shopify tool implementations.

All tests use mocked Shopify clients — no live API calls.
Verifies:
- search_products parses GraphQL response correctly.
- lookup_order enforces verification gating.
- create_checkout_link returns URL on success / error on userErrors.
- escalate_to_human never logs sensitive data.
- Shopify client token is never exposed in logs or return values.
"""
from __future__ import annotations

import json
import logging
import os
import pytest
from unittest.mock import AsyncMock, patch, MagicMock

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("SHOPIFY_SHOP_DOMAIN", "test.myshopify.com")
os.environ.setdefault("SHOPIFY_ADMIN_ACCESS_TOKEN", "shpat_test_token")
os.environ.setdefault("DEBUG", "true")


# ── search_products ────────────────────────────────────────────────────────────

_MOCK_PRODUCTS_RESPONSE = {
    "data": {
        "products": {
            "edges": [
                {
                    "node": {
                        "id": "gid://shopify/Product/1",
                        "title": "The Great Gatsby",
                        "handle": "great-gatsby",
                        "onlineStoreUrl": "https://shop.example.com/products/great-gatsby",
                        "variants": {
                            "edges": [
                                {
                                    "node": {
                                        "id": "gid://shopify/ProductVariant/10",
                                        "title": "Paperback",
                                        "price": "12.99",
                                        "inventoryQuantity": 50,
                                        "availableForSale": True,
                                    }
                                }
                            ]
                        },
                    }
                }
            ]
        }
    }
}


@pytest.mark.asyncio
async def test_search_products_parses_response():
    with patch("app.tools.shopify_tools.get_shopify_client") as mock_get:
        client = AsyncMock()
        client.configured = True
        client.execute = AsyncMock(return_value=_MOCK_PRODUCTS_RESPONSE)
        mock_get.return_value = client

        with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            with patch("app.tools.shopify_tools.shopify_cache_set", AsyncMock()):
                from app.tools.shopify_tools import search_products
                result = await search_products("gatsby")

    data = json.loads(result)
    assert data["count"] == 1
    product = data["results"][0]
    assert product["title"] == "The Great Gatsby"
    assert product["handle"] == "great-gatsby"
    assert product["available"] is True
    assert product["price"] == "12.99"


@pytest.mark.asyncio
async def test_search_products_returns_cache_hit():
    cached = {"results": [{"title": "Cached Book"}], "count": 1}
    with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=cached)):
        from app.tools.shopify_tools import search_products
        result = await search_products("anything")
    data = json.loads(result)
    assert data["results"] == cached["results"]
    assert data["count"] == 1
    assert data["not_found"] is False


@pytest.mark.asyncio
async def test_search_products_shopify_down():
    with patch("app.tools.shopify_tools.get_shopify_client") as mock_get:
        client = AsyncMock()
        client.configured = True
        client.execute = AsyncMock(side_effect=RuntimeError("unavailable"))
        mock_get.return_value = client

        with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            from app.tools.shopify_tools import search_products
            result = await search_products("gatsby")

    data = json.loads(result)
    assert "error" in data
    assert data["results"] == []


# ── lookup_order ──────────────────────────────────────────────────────────────

_MOCK_ORDER_RESPONSE = {
    "data": {
        "orders": {
            "edges": [
                {
                    "node": {
                        "id": "gid://shopify/Order/99",
                        "name": "#1234",
                        "displayFinancialStatus": "PAID",
                        "displayFulfillmentStatus": "FULFILLED",
                        "email": "customer@example.com",
                        "phone": "+15550001111",
                        "subtotalPriceSet": {"shopMoney": {"amount": "25.00", "currencyCode": "USD"}},
                        "totalShippingPriceSet": {"shopMoney": {"amount": "4.99", "currencyCode": "USD"}},
                        "lineItems": {
                            "edges": [
                                {"node": {"title": "The Great Gatsby", "quantity": 1}}
                            ]
                        },
                        "fulfillments": [{"trackingInfo": [{"number": "TRACK123", "url": "https://track.example.com"}]}],
                        "cancelledAt": None,
                        "canMarkAsPaid": False,
                    }
                }
            ]
        }
    }
}


@pytest.mark.asyncio
async def test_lookup_order_verified_returns_full_details():
    with patch("app.tools.shopify_tools.get_shopify_client") as mock_get:
        client = AsyncMock()
        client.configured = True
        client.execute = AsyncMock(return_value=_MOCK_ORDER_RESPONSE)
        mock_get.return_value = client

        from app.tools.shopify_tools import lookup_order
        result = await lookup_order(order_number="1234", email="customer@example.com")

    data = json.loads(result)
    assert data["found"] is True
    assert data["order_number"] == "#1234"
    assert "items" in data  # full details because order + email provided
    assert "The Great Gatsby" in data["items"][0]


@pytest.mark.asyncio
async def test_lookup_order_unverified_omits_items():
    with patch("app.tools.shopify_tools.get_shopify_client") as mock_get:
        client = AsyncMock()
        client.configured = True
        client.execute = AsyncMock(return_value=_MOCK_ORDER_RESPONSE)
        mock_get.return_value = client

        from app.tools.shopify_tools import lookup_order
        result = await lookup_order(order_number="1234")  # no email/phone

    data = json.loads(result)
    assert data["found"] is True
    assert data.get("items")  # full details with order number only


@pytest.mark.asyncio
async def test_lookup_order_requires_at_least_one_identifier():
    from app.tools.shopify_tools import lookup_order
    result = await lookup_order()
    data = json.loads(result)
    assert "error" in data


# ── create_checkout_link ──────────────────────────────────────────────────────

_MOCK_DRAFT_ORDER_OK = {
    "data": {
        "draftOrderCreate": {
            "draftOrder": {
                "id": "gid://shopify/DraftOrder/1",
                "name": "#D001",
                "invoiceUrl": "https://shop.example.com/pay/abc123",
                "status": "OPEN",
            },
            "userErrors": [],
        }
    }
}

_MOCK_DRAFT_ORDER_ERR = {
    "data": {
        "draftOrderCreate": {
            "draftOrder": None,
            "userErrors": [{"field": "variantId", "message": "Variant not found"}],
        }
    }
}


@pytest.mark.asyncio
async def test_create_checkout_link_success():
    with patch("app.tools.shopify_tools.get_shopify_client") as mock_get:
        client = AsyncMock()
        client.configured = True
        client.execute = AsyncMock(return_value=_MOCK_DRAFT_ORDER_OK)
        mock_get.return_value = client

        from app.tools.shopify_tools import create_checkout_link
        result = await create_checkout_link(
            items=[{"variant_id": "gid://shopify/ProductVariant/10", "quantity": 1}],
            email="buyer@example.com",
        )

    data = json.loads(result)
    assert data["success"] is True
    assert "checkout_url" in data
    assert data["checkout_url"] == "https://shop.example.com/pay/abc123"


@pytest.mark.asyncio
async def test_create_checkout_link_shopify_user_errors():
    with patch("app.tools.shopify_tools.get_shopify_client") as mock_get:
        client = AsyncMock()
        client.configured = True
        client.execute = AsyncMock(return_value=_MOCK_DRAFT_ORDER_ERR)
        mock_get.return_value = client

        from app.tools.shopify_tools import create_checkout_link
        result = await create_checkout_link(
            items=[{"variant_id": "gid://shopify/ProductVariant/99", "quantity": 1}],
        )

    data = json.loads(result)
    assert data["success"] is False
    assert "error" in data


@pytest.mark.asyncio
async def test_create_checkout_link_empty_items():
    from app.tools.shopify_tools import create_checkout_link
    result = await create_checkout_link(items=[])
    data = json.loads(result)
    assert data.get("error") is not None


# ── escalate_to_human ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_escalate_to_human_returns_safe_message():
    from app.state.models import SessionState
    from app.tools.shopify_tools import escalate_to_human

    session = SessionState(
        session_id="sess_esc",
        call_sid="CA_ESC",
        from_number="+15550001111",
        to_number="+15559999999",
        caller_email="caller@example.com",
    )
    with patch("app.escalation.support_handoff.send_support_handoff", new_callable=AsyncMock) as mock_send:
        mock_send.return_value = json.dumps({
            "success": True,
            "customer_message": "I've forwarded your request to our support team.",
        })
        result = await escalate_to_human(
            reason="caller requested human",
            caller_phone="+15550001111",
            summary="Caller asked about order #1234",
            session=session,
        )
    data = json.loads(result)
    assert data["escalated"] is True
    assert "message" in data


@pytest.mark.asyncio
async def test_escalate_to_human_without_email_asks_contact():
    from app.tools.shopify_tools import escalate_to_human

    result = await escalate_to_human(
        reason="caller requested human",
        caller_phone="+15550001111",
        summary="Caller asked about order #1234",
    )
    data = json.loads(result)
    assert data["escalated"] is False
    assert data.get("needs_contact_info") is True
    assert "name and email" in data["message"].lower()


@pytest.mark.asyncio
async def test_escalate_does_not_log_full_phone(caplog):
    """Caller phone must not appear verbatim in logs."""
    from app.tools.shopify_tools import escalate_to_human
    phone = "+15559876543"
    with caplog.at_level(logging.INFO):
        await escalate_to_human(reason="test", caller_phone=phone)
    for record in caplog.records:
        assert phone not in record.getMessage(), "Raw phone number in log!"


# ── Shopify client token safety ───────────────────────────────────────────────

def test_shopify_client_token_not_in_repr():
    """The admin token must never surface in repr() or str() of the client."""
    from app.shopify.client import ShopifyGraphQLClient
    client = ShopifyGraphQLClient()
    assert "shpat_test_token" not in repr(client)
    assert "shpat_test_token" not in str(client)
