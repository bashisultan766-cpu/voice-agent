"""
ISBN capture, Shopify ISBN search, and order lookup regression tests (v4.50).
"""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("SHOPIFY_SHOP_DOMAIN", "test.myshopify.com")
os.environ.setdefault("SHOPIFY_ADMIN_ACCESS_TOKEN", "shpat_test_token")

from app.agents.main_commerce_brain import MainCommerceBrain
from app.runtime.fast_classifier import classify
from app.tools.isbn import extract_isbn_candidate, normalize_isbn
from app.voice.turn_assembler import TurnAssembler, AssembledTurn

_VALID_ISBN = "9780143127741"
_VALID_ISBN_SPACED = "978 0 14 312774 1"


@pytest.fixture(autouse=True)
def _patch_order_timeline_fetch(monkeypatch):
    async def _empty_timeline(*_args, **_kwargs):
        return []

    monkeypatch.setattr("app.tools.shopify_tools._fetch_order_timeline", _empty_timeline)


def _variant_node(*, barcode: str = "", sku: str = "", title: str = "Test Book", price: str = "14.99"):
    return {
        "id": "gid://shopify/ProductVariant/1",
        "barcode": barcode,
        "sku": sku,
        "price": price,
        "availableForSale": True,
        "inventoryQuantity": 5,
        "title": "Default",
        "product": {
            "id": "gid://shopify/Product/1",
            "title": title,
            "handle": "test-book",
            "productType": "Book",
            "onlineStoreUrl": "https://shop.example.com/test-book",
            "featuredImage": {"url": "https://cdn.example.com/img.jpg"},
            "metafields": {"edges": []},
        },
    }


_MOCK_ORDER_NODE = {
    "id": "gid://shopify/Order/99",
    "name": "#1009",
    "createdAt": "2025-03-15T10:00:00Z",
    "displayFinancialStatus": "PAID",
    "displayFulfillmentStatus": "FULFILLED",
    "email": "john.smith@gmail.com",
    "phone": "+15550001111",
    "customer": {"firstName": "John", "lastName": "Smith", "email": "john.smith@gmail.com"},
    "subtotalPriceSet": {"shopMoney": {"amount": "25.00", "currencyCode": "USD"}},
    "totalShippingPriceSet": {"shopMoney": {"amount": "4.99", "currencyCode": "USD"}},
    "totalTaxSet": {"shopMoney": {"amount": "2.00", "currencyCode": "USD"}},
    "totalDiscountsSet": {"shopMoney": {"amount": "0.00", "currencyCode": "USD"}},
    "totalPriceSet": {"shopMoney": {"amount": "31.99", "currencyCode": "USD"}},
    "lineItems": {
        "edges": [
            {
                "node": {
                    "title": "The Great Gatsby",
                    "quantity": 2,
                    "sku": "GG-001",
                    "originalUnitPriceSet": {"shopMoney": {"amount": "12.50", "currencyCode": "USD"}},
                    "variant": {"barcode": "9780743273565", "sku": "GG-001"},
                }
            }
        ]
    },
    "fulfillments": [
        {
            "status": "SUCCESS",
            "trackingInfo": [{"company": "USPS", "number": "TRACK123", "url": "https://track.example.com"}],
        }
    ],
    "refunds": [
        {
            "id": "gid://shopify/Refund/1",
            "createdAt": "2025-03-20T12:00:00Z",
            "totalRefundedSet": {"shopMoney": {"amount": "12.50", "currencyCode": "USD"}},
            "refundLineItems": {
                "edges": [{"node": {"quantity": 1, "lineItem": {"title": "The Great Gatsby"}}}]
            },
            "transactions": [
                {"paymentDetails": {"number": "****1234", "company": "Visa"}}
            ],
        }
    ],
    "transactions": [{"paymentDetails": {"number": "****5678", "company": "Visa"}}],
}


# ── ISBN capture ──────────────────────────────────────────────────────────────


def test_can_i_give_isbn_prompts_immediately():
    result = classify("Can I give you the ISBN number?")
    assert result.action == "instant"
    assert result.skip_llm is True
    assert "go ahead" in result.instant_reply.lower()
    assert "isbn" in result.instant_reply.lower()


def test_isbn_with_spaces_normalizes():
    assert extract_isbn_candidate(_VALID_ISBN_SPACED) == _VALID_ISBN


def test_spoken_digits_normalize():
    spoken = "nine seven eight zero one four three one two seven seven four one"
    assert normalize_isbn(spoken) == _VALID_ISBN
    assert extract_isbn_candidate(spoken) == _VALID_ISBN


@pytest.mark.asyncio
async def test_isbn_permission_question_emits_immediately_no_hold():
    assembler = TurnAssembler()
    emitted: list[AssembledTurn] = []

    async def on_emit(turn: AssembledTurn) -> None:
        emitted.append(turn)

    held = await assembler.ingest("Can I give you the ISBN number?", on_emit, call_sid="CA2")
    assert held is False
    assert len(emitted) == 1
    assert "isbn" in emitted[0].text.lower()


@pytest.mark.asyncio
async def test_full_isbn_not_held_on_digit_count():
    assembler = TurnAssembler()
    emitted: list[AssembledTurn] = []

    async def on_emit(turn: AssembledTurn) -> None:
        emitted.append(turn)

    held = await assembler.ingest(_VALID_ISBN, on_emit, call_sid="CA1")
    assert held is False
    assert len(emitted) == 1
    assert _VALID_ISBN in emitted[0].text.replace(" ", "")


@pytest.mark.asyncio
async def test_partial_isbn_asks_for_remaining_digits():
    with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
        from app.tools.shopify_tools import search_product_by_isbn

        result = json.loads(await search_product_by_isbn("97801431277"))
    assert result["needs_more_digits"] is True
    assert "remaining digits" in result["customer_message"].lower()


def test_invalid_isbn_asks_repeat():
    with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
        from app.tools.shopify_tools import search_product_by_isbn

        # 10-digit run with invalid checksum — not a 978 partial fragment
        result = json.loads(asyncio.run(search_product_by_isbn("1234567890")))
    assert result["found"] is False
    assert "valid isbn" in result["customer_message"].lower() or "again" in result["customer_message"].lower()


# ── ISBN Shopify search ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_search_product_by_isbn_barcode_first():
    variant = _variant_node(barcode=_VALID_ISBN)

    async def execute(query, variables=None):
        q = variables.get("barcode", "")
        if q == f"barcode:{_VALID_ISBN}":
            return {"data": {"productVariants": {"edges": [{"node": variant}]}}}
        return {"data": {"productVariants": {"edges": []}}}

    with patch("app.tools.shopify_tools.get_shopify_client") as mock_get:
        client = AsyncMock()
        client.configured = True
        client.execute = AsyncMock(side_effect=execute)
        mock_get.return_value = client
        with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            with patch("app.tools.shopify_tools.shopify_cache_set", AsyncMock()):
                with patch("app.sync.repositories.ProductCache") as pc:
                    pc.return_value.get_by_isbn = AsyncMock(return_value=None)
                    from app.tools.shopify_tools import search_product_by_isbn
                    result = json.loads(await search_product_by_isbn(_VALID_ISBN))

    assert result["found"] is True
    assert result["match_type"] == "barcode"
    assert result["confidence"] >= 0.99


@pytest.mark.asyncio
async def test_search_product_by_isbn_sku_fallback():
    variant = _variant_node(sku=_VALID_ISBN, barcode="")

    call_count = {"n": 0}

    async def execute(query, variables=None):
        call_count["n"] += 1
        q = variables.get("barcode", "")
        if q == f"barcode:{_VALID_ISBN}":
            return {"data": {"productVariants": {"edges": []}}}
        if q == f"sku:{_VALID_ISBN}":
            return {"data": {"productVariants": {"edges": [{"node": variant}]}}}
        return {"data": {"productVariants": {"edges": []}}}

    with patch("app.tools.shopify_tools.get_shopify_client") as mock_get:
        client = AsyncMock()
        client.configured = True
        client.execute = AsyncMock(side_effect=execute)
        mock_get.return_value = client
        with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            with patch("app.tools.shopify_tools.shopify_cache_set", AsyncMock()):
                with patch("app.sync.repositories.ProductCache") as pc:
                    pc.return_value.get_by_isbn = AsyncMock(return_value=None)
                    from app.tools.shopify_tools import search_product_by_isbn
                    result = json.loads(await search_product_by_isbn(_VALID_ISBN))

    assert result["found"] is True
    assert result["match_type"] == "sku"


@pytest.mark.asyncio
async def test_search_product_by_isbn_metafield_fallback():
    product_node = {
        "id": "gid://shopify/Product/2",
        "title": "Metafield Book",
        "handle": "meta-book",
        "variants": {
            "edges": [{"node": {"id": "gid://shopify/ProductVariant/2", "price": "9.99", "availableForSale": True, "inventoryQuantity": 1}}]
        },
    }

    async def execute(query, variables=None):
        q = variables.get("query", "")
        if "metafields" in q:
            return {"data": {"products": {"edges": [{"node": product_node}]}}}
        return {"data": {"productVariants": {"edges": []}, "products": {"edges": []}}}

    with patch("app.tools.shopify_tools.get_shopify_client") as mock_get:
        client = AsyncMock()
        client.configured = True
        client.execute = AsyncMock(side_effect=execute)
        mock_get.return_value = client
        with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            with patch("app.tools.shopify_tools.shopify_cache_set", AsyncMock()):
                with patch("app.sync.repositories.ProductCache") as pc:
                    pc.return_value.get_by_isbn = AsyncMock(return_value=None)
                    from app.tools.shopify_tools import search_product_by_isbn
                    result = json.loads(await search_product_by_isbn(_VALID_ISBN))

    assert result["found"] is True
    assert result["match_type"] == "metafield"


@pytest.mark.asyncio
async def test_search_product_by_isbn_not_found():
    with patch("app.tools.shopify_tools.get_shopify_client") as mock_get:
        client = AsyncMock()
        client.configured = True
        client.execute = AsyncMock(return_value={"data": {"productVariants": {"edges": []}, "products": {"edges": []}}})
        mock_get.return_value = client
        with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            with patch("app.tools.shopify_tools.shopify_cache_set", AsyncMock()):
                with patch("app.sync.repositories.ProductCache") as pc:
                    pc.return_value.get_by_isbn = AsyncMock(return_value=None)
                    from app.tools.shopify_tools import search_product_by_isbn
                    result = json.loads(await search_product_by_isbn(_VALID_ISBN))

    assert result["found"] is False
    assert result["match_type"] == "none"
    assert "not showing as available" in result["customer_message"].lower()


@pytest.mark.asyncio
async def test_search_product_by_isbn_uncertain_fallback_asks_confirmation():
    product_node = {
        "id": "gid://shopify/Product/3",
        "title": "Maybe This Book",
        "handle": "maybe",
        "variants": {"edges": [{"node": {"id": "v3", "price": "11.00", "availableForSale": True}}]},
    }

    async def execute(query, variables=None):
        if variables.get("query") == _VALID_ISBN:
            return {"data": {"products": {"edges": [{"node": product_node}]}}}
        return {"data": {"productVariants": {"edges": []}, "products": {"edges": []}}}

    with patch("app.tools.shopify_tools.get_shopify_client") as mock_get:
        client = AsyncMock()
        client.configured = True
        client.execute = AsyncMock(side_effect=execute)
        mock_get.return_value = client
        with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            with patch("app.sync.repositories.ProductCache") as pc:
                pc.return_value.get_by_isbn = AsyncMock(return_value=None)
                from app.tools.shopify_tools import search_product_by_isbn
                result = json.loads(await search_product_by_isbn(_VALID_ISBN))

    assert result["found"] is True
    assert result["match_type"] == "title_fallback"
    assert result.get("needs_confirmation") is True


@dataclass
class _FakeFunction:
    name: str
    arguments: str


@dataclass
class _FakeToolCall:
    id: str
    function: _FakeFunction
    type: str = "function"


@dataclass
class _FakeMessage:
    content: str | None = None
    tool_calls: list | None = None


@dataclass
class _FakeChoice:
    message: _FakeMessage


class _FakeUsage:
    prompt_tokens = 10
    completion_tokens = 5
    total_tokens = 15


@dataclass
class _FakeResponse:
    choices: list
    usage: _FakeUsage = field(default_factory=_FakeUsage)


class _FakeCompletions:
    def __init__(self, scripted):
        self._scripted = list(scripted)

    async def create(self, **kwargs):
        if self._scripted:
            return self._scripted.pop(0)
        return _FakeResponse(choices=[_FakeChoice(_FakeMessage(content="Found it."))])


class _FakeClient:
    def __init__(self, scripted):
        self.chat = type("Ch", (), {"completions": _FakeCompletions(scripted)})()


def _tool_response(tool_name: str, args: dict) -> _FakeResponse:
    return _FakeResponse(choices=[
        _FakeChoice(_FakeMessage(
            content=None,
            tool_calls=[_FakeToolCall("tc1", _FakeFunction(tool_name, json.dumps(args)))],
        ))
    ])


def _text_response(text: str) -> _FakeResponse:
    return _FakeResponse(choices=[_FakeChoice(_FakeMessage(content=text))])


@pytest.mark.asyncio
async def test_main_brain_calls_search_product_by_isbn_for_isbn():
    from app.agent_runtime import llm_tools
    from app.state.models import SessionState

    brain = MainCommerceBrain()
    brain._client = _FakeClient([
        _tool_response("search_product_by_isbn", {"isbn": _VALID_ISBN}),
        _text_response("Yes, I found that book."),
    ])
    session = SessionState(
        session_id="s1", call_sid="CA1", from_number="+15551230000", to_number="+15559999999",
    )

    async def fake_dispatch(name, args, session):
        return json.dumps({"found": True, "product": {"title": "Test"}})

    with patch.object(llm_tools, "dispatch", side_effect=fake_dispatch):
        text, tools, _ = await brain.run_turn(session, f"The ISBN is {_VALID_ISBN}")

    assert "search_product_by_isbn" in tools
    assert text


# ── Order lookup ──────────────────────────────────────────────────────────────


def _order_mock_client():
    client = AsyncMock()
    client.configured = True
    client.execute = AsyncMock(
        return_value={"data": {"orders": {"edges": [{"node": _MOCK_ORDER_NODE}]}}}
    )
    return client


@pytest.mark.asyncio
async def test_order_number_only_returns_full_details():
    with patch("app.tools.shopify_tools.get_shopify_client", return_value=_order_mock_client()):
        with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            with patch("app.tools.shopify_tools.shopify_cache_set", AsyncMock()):
                from app.tools.shopify_tools import lookup_shopify_order_details
                result = json.loads(await lookup_shopify_order_details("1009"))

    assert result["found"] is True
    assert result["verification_required"] is False
    order = result["order"]
    assert order["items"]
    assert order["pricing"]["subtotal"]
    assert order["pricing"]["shipping"]
    assert order["pricing"]["total"]
    assert order["refunds"]
    assert order["customer_name"] == "John Smith"
    assert "subtotal before shipping" in result["customer_message"].lower()
    assert "ending in" in result["customer_message"].lower()
    assert "1234" in result["customer_message"] or "5678" in result["customer_message"]


@pytest.mark.asyncio
async def test_order_number_only_query_does_not_add_caller_phone():
    from app.state.models import SessionState

    client = _order_mock_client()

    async def capture_execute(query, variables=None):
        client._last_query = variables.get("query", "")
        return {"data": {"orders": {"edges": [{"node": _MOCK_ORDER_NODE}]}}}

    client.execute = AsyncMock(side_effect=capture_execute)

    session = SessionState(
        session_id="s1", call_sid="CA1", from_number="+19998887777",
        to_number="+15559999999", verified_phone=False,
    )
    with patch("app.tools.shopify_tools.get_shopify_client", return_value=client):
        with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            with patch("app.tools.shopify_tools.shopify_cache_set", AsyncMock()):
                from app.tools.shopify_tools import lookup_shopify_order_details
                await lookup_shopify_order_details("1009", session=session)

    assert "phone:" not in client._last_query
    assert "name:#1009" in client._last_query


@pytest.mark.asyncio
async def test_order_lookup_falls_back_when_hash_query_misses():
    client = AsyncMock()
    client.configured = True
    queries: list[str] = []

    async def capture_execute(query, variables=None):
        q = (variables or {}).get("query", "")
        queries.append(q)
        if q == "name:#1009":
            return {"data": {"orders": {"edges": []}}}
        if q in ("name:1009", 'name:"1009"'):
            return {"data": {"orders": {"edges": [{"node": _MOCK_ORDER_NODE}]}}}
        return {"data": {"orders": {"edges": []}}}

    client.execute = AsyncMock(side_effect=capture_execute)

    with patch("app.tools.shopify_tools.get_shopify_client", return_value=client):
        with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            with patch("app.tools.shopify_tools.shopify_cache_set", AsyncMock()):
                from app.tools.shopify_tools import lookup_shopify_order_details
                result = json.loads(await lookup_shopify_order_details("1009"))

    assert result["found"] is True
    assert queries[0] == "name:#1009"
    assert any("name:1009" in q for q in queries)


@pytest.mark.asyncio
async def test_verified_phone_not_injected_for_order_number_lookup():
    from app.state.models import SessionState

    client = _order_mock_client()
    queries: list[str] = []

    async def capture_execute(query, variables=None):
        queries.append((variables or {}).get("query", ""))
        return {"data": {"orders": {"edges": [{"node": _MOCK_ORDER_NODE}]}}}

    client.execute = AsyncMock(side_effect=capture_execute)

    session = SessionState(
        session_id="s1", call_sid="CA1", from_number="+19998887777",
        to_number="+15559999999", verified_phone=True,
    )
    with patch("app.tools.shopify_tools.get_shopify_client", return_value=client):
        with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            with patch("app.tools.shopify_tools.shopify_cache_set", AsyncMock()):
                from app.tools.shopify_tools import lookup_shopify_order_details
                await lookup_shopify_order_details("1009", session=session)

    assert queries
    assert all("phone:" not in q for q in queries)


def test_spoken_order_number_extracted():
    from app.agent_runtime.order_flow_state import extract_order_number

    assert extract_order_number("four seven nine zero five") == "47905"
    assert extract_order_number("The order number is 4 7 9 0 5") == "47905"
    assert extract_order_number("47905") == "47905"


def test_refunded_order_customer_message_covers_email_card_shipping_timeline():
    from app.tools.shopify_tools import (
        _build_full_order_from_node,
        _format_order_customer_message,
        _timeline_from_node,
    )

    node = {
        **_MOCK_ORDER_NODE,
        "name": "#22318",
        "displayFinancialStatus": "REFUNDED",
        "displayFulfillmentStatus": "FULFILLED",
        "email": "jdos403@gmail.com",
        "totalShippingPriceSet": {"shopMoney": {"amount": "0.00", "currencyCode": "USD"}},
        "totalPriceSet": {"shopMoney": {"amount": "9.99", "currencyCode": "USD"}},
        "subtotalPriceSet": {"shopMoney": {"amount": "9.99", "currencyCode": "USD"}},
        "lineItems": {
            "edges": [{
                "node": {
                    "title": "The Witching Hour",
                    "quantity": 1,
                    "sku": "0345384466",
                    "originalUnitPriceSet": {"shopMoney": {"amount": "9.99", "currencyCode": "USD"}},
                    "variant": {"barcode": "", "sku": "0345384466"},
                }
            }]
        },
        "fulfillments": [{"status": "SUCCESS", "trackingInfo": []}],
        "customer": {
            "firstName": "Jennifer",
            "lastName": "Dosanjh",
            "email": "jdos403@gmail.com",
            "numberOfOrders": 6,
        },
        "billingAddress": {"city": "Calgary", "provinceCode": "AB", "countryCode": "CA"},
        "refunds": [{
            "createdAt": "2022-05-25T12:58:00Z",
            "note": "DO NOT SHIP outside USA",
            "totalRefundedSet": {"shopMoney": {"amount": "9.99", "currencyCode": "USD"}},
            "refundLineItems": {
                "edges": [{"node": {"quantity": 1, "lineItem": {"title": "The Witching Hour"}}}]
            },
            "transactions": {
                "edges": [{"node": {"paymentDetails": {"number": "****0525", "company": "Visa"}}}]
            },
        }],
        "transactions": [{"paymentDetails": {"number": "****0525", "company": "Visa"}}],
    }
    order_obj = _build_full_order_from_node(node, order_email="jdos403@gmail.com")
    order_obj["timeline"] = _timeline_from_node({
        "events": {
            "edges": [{
                "node": {
                    "__typename": "BasicEvent",
                    "createdAt": "2022-05-25T12:58:00Z",
                    "message": "Jessica Glass refunded $9.99 USD using a Visa ending in 0525.",
                }
            }]
        }
    })
    msg = _format_order_customer_message(order_obj, order_email="jdos403@gmail.com")
    lower = msg.lower()
    assert "refunded" in lower
    assert "0525" in msg
    assert "jdos403@gmail.com" in msg
    assert "shipping" in lower
    assert "6 order" in lower
    assert "do not ship outside usa" in lower
    assert "witching hour" in lower
    assert "shopify order timeline" in lower


@pytest.mark.asyncio
async def test_order_number_includes_all_fields_without_email():
    result = json.loads(await _lookup_with_mocks("1009", email_or_phone=None))
    order = result["order"]
    assert order["items"]
    assert order["pricing"]
    assert order["refunds"]
    assert order["tracking"]
    assert result["verification_required"] is False


async def _lookup_with_mocks(order_number: str, email_or_phone: str | None):
    with patch("app.tools.shopify_tools.get_shopify_client", return_value=_order_mock_client()):
        with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            with patch("app.tools.shopify_tools.shopify_cache_set", AsyncMock()):
                with patch("app.tools.shopify_tools._fetch_order_timeline", AsyncMock(return_value=[])):
                    from app.tools.shopify_tools import lookup_shopify_order_details
                    return await lookup_shopify_order_details(order_number, email_or_phone=email_or_phone)


@pytest.mark.asyncio
async def test_verified_order_includes_items():
    result = json.loads(await _lookup_with_mocks("1009", "john.smith@gmail.com"))
    items = result["order"]["items"]
    assert items
    assert items[0]["title"] == "The Great Gatsby"


@pytest.mark.asyncio
async def test_verified_order_includes_quantities():
    result = json.loads(await _lookup_with_mocks("1009", "john.smith@gmail.com"))
    assert result["order"]["items"][0]["quantity"] == 2


@pytest.mark.asyncio
async def test_verified_order_includes_pricing_breakdown():
    result = json.loads(await _lookup_with_mocks("1009", "john.smith@gmail.com"))
    pricing = result["order"]["pricing"]
    assert "25.00" in pricing["subtotal"]
    assert "4.99" in pricing["shipping"]
    assert "2.00" in pricing["tax"]
    assert "31.99" in pricing["total"]


@pytest.mark.asyncio
async def test_verified_order_includes_tracking():
    result = json.loads(await _lookup_with_mocks("1009", "john.smith@gmail.com"))
    tracking = result["order"]["tracking"]
    assert tracking["tracking_number"] == "TRACK123"
    assert tracking["carrier"] == "USPS"


@pytest.mark.asyncio
async def test_verified_order_includes_refund_details():
    result = json.loads(await _lookup_with_mocks("1009", "john.smith@gmail.com"))
    refunds = result["order"]["refunds"]
    assert refunds
    assert "12.50" in refunds[0]["amount"]
    assert refunds[0]["created_at"] == "2025-03-20"


@pytest.mark.asyncio
async def test_refund_card_only_exposes_last4():
    result = json.loads(await _lookup_with_mocks("1009", "john.smith@gmail.com"))
    last4 = result["order"]["refunds"][0]["card_last4"]
    assert last4 == "1234"
    assert len(last4) == 4


@pytest.mark.asyncio
async def test_order_not_found_safe_message():
    client = AsyncMock()
    client.configured = True
    client.execute = AsyncMock(return_value={"data": {"orders": {"edges": []}}})
    with patch("app.tools.shopify_tools.get_shopify_client", return_value=client):
        with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            from app.tools.shopify_tools import lookup_shopify_order_details
            result = json.loads(await lookup_shopify_order_details("9999"))

    assert result["found"] is False
    assert result["customer_message"]


@pytest.mark.asyncio
async def test_main_brain_calls_lookup_shopify_order_details():
    from app.agent_runtime import llm_tools
    from app.state.models import SessionState

    brain = MainCommerceBrain()
    brain._client = _FakeClient([
        _tool_response("lookup_shopify_order_details", {"order_number": "1009"}),
        _text_response("Your order is fulfilled."),
    ])
    session = SessionState(
        session_id="s1", call_sid="CA1", from_number="+15551230000", to_number="+15559999999",
    )

    async def fake_dispatch(name, args, session):
        return json.dumps({"found": True, "verification_required": True})

    with patch.object(llm_tools, "dispatch", side_effect=fake_dispatch):
        text, tools, _ = await brain.run_turn(session, "Check order number 1009")

    assert "lookup_shopify_order_details" in tools
    assert text


# ── Voice silence guards ──────────────────────────────────────────────────────


def test_no_silence_on_isbn_question():
    result = classify("Can I give you the ISBN number?")
    assert result.instant_reply
    assert result.skip_llm is True


def test_no_silence_on_order_lookup():
    result = classify("Where is my order 1009?")
    assert result.action == "brain"
    assert result.is_order_lookup is True


def test_tool_failure_gives_safe_fallback():
    from app.agent_runtime import llm_tools
    from app.state.models import SessionState

    brain = MainCommerceBrain()
    brain._client = _FakeClient([
        _tool_response("search_product_by_isbn", {"isbn": _VALID_ISBN}),
        _text_response("Sorry, I could not find that."),
    ])
    session = SessionState(
        session_id="s1", call_sid="CA1", from_number="+15551230000", to_number="+15559999999",
    )

    async def failing_dispatch(name, args, session):
        return json.dumps({"error": "Shopify unavailable", "found": False})

    with patch.object(llm_tools, "dispatch", side_effect=failing_dispatch):
        text, _, _ = asyncio.run(brain.run_turn(session, f"ISBN {_VALID_ISBN}"))

    assert text
