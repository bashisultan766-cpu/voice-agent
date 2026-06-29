"""
Support handoff upgrade — canonical escalation, order lookup, sanitizer tests.
"""
from __future__ import annotations

import importlib
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent_runtime.not_found_escalation_flow import (
    process_not_found_escalation_turn,
    try_escalate_unresolved_query,
)
from app.agent_runtime.order_flow_state import try_order_enrichment_short_circuit
from app.config import Settings
from app.escalation.models import CustomerQueryEscalationPayload
from app.escalation.product_not_found_escalation import _STORE
from app.escalation.support_handoff import send_support_handoff
from app.safety.response_sanitizer import sanitize_customer_response
from app.shopify import graphql_queries
from app.state.models import SessionState
from app.tools.shopify_tools import (
    _build_customer_safe_tool_response,
    _build_full_order_from_node,
    customer_facing_order_tool_json,
)


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="sess_sh_001",
        call_sid="CA_SH001",
        from_number="+15551234001",
        to_number="+15559994001",
        caller_name="Maria Lopez",
    )
    base.update(kwargs)
    return SessionState(**base)


@pytest.fixture(autouse=True)
def _clear_escalation_store():
    from app.escalation import product_not_found_escalation as pne

    _STORE.clear()
    pne._SYNC_REDIS = None
    with patch.object(pne, "_get_sync_redis", return_value=None):
        yield
    _STORE.clear()
    pne._SYNC_REDIS = None


def _settings() -> Settings:
    return Settings(
        SUPPORT_EMAIL="jessica@sureshotbooks.com",
        RESEND_API_KEY="re_test",
        SUPPORT_ESCALATION_FROM_EMAIL="Voice Agent <noreply@sureshotbooks.com>",
        SUPPORT_ESCALATION_ENABLED=True,
    )


def _mock_resend():
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


def test_duplicate_customer_query_escalation_module_removed():
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("app.escalation.customer_query_escalation")


def test_get_order_with_refunds_has_no_order_adjustments():
    assert "orderAdjustments" not in graphql_queries.GET_ORDER_WITH_REFUNDS


@pytest.mark.asyncio
async def test_product_not_found_support_handoff_asks_contact():
    session = _session()
    hint = await try_escalate_unresolved_query(
        session,
        caller_text="I need book XYZ-999",
        query_type="product",
        issue_title="Product XYZ-999 not in catalog",
        issue_detail="Catalog search returned zero results.",
    )
    assert "forward your message" in hint.force_reply.lower()
    assert "name and email" in hint.force_reply.lower()
    assert session.awaiting_not_found_escalation_email is True


@pytest.mark.asyncio
async def test_order_not_found_does_not_auto_escalate():
    session = _session(caller_email="maria@example.com")
    with patch(
        "app.agent_runtime.order_parallel_enrichment.enrich_order_parallel",
        new_callable=AsyncMock,
    ) as mock_enrich:
        mock_enrich.return_value = MagicMock(
            order={"found": False, "error_code": "order_not_found", "order_number": "22399"},
            suggested_response="I couldn't find order 22399 in our system. Could you double-check the order number?",
        )
        hint = await try_order_enrichment_short_circuit(session, "order 22399")

    assert hint and hint.force_reply
    assert "22399" in hint.force_reply
    assert session.awaiting_not_found_escalation_email is False
    assert not session.pending_not_found_escalation


@pytest.mark.asyncio
async def test_shopify_api_error_does_not_auto_escalate():
    session = _session(confirmed_email="maria@example.com", caller_email="maria@example.com")
    with patch(
        "app.agent_runtime.order_parallel_enrichment.enrich_order_parallel",
        new_callable=AsyncMock,
    ) as mock_enrich:
        mock_enrich.return_value = MagicMock(
            order={"found": False, "error_code": "shopify_api_error"},
            suggested_response="I'm having trouble reaching our order system right now.",
        )
        hint = await try_order_enrichment_short_circuit(session, "order 10001")

    assert hint and hint.force_reply
    assert "order system" in hint.force_reply.lower()
    assert session.awaiting_not_found_escalation_email is False


@pytest.mark.asyncio
async def test_shopify_api_error_support_handoff_stages_contact():
    session = _session(confirmed_email="maria@example.com")
    hint = await try_escalate_unresolved_query(
        session,
        query_type="shopify_api_error",
        issue_title="Shopify API error",
        issue_detail="GraphQL timeout",
        api_context={"error": "timeout"},
        reason="shopify_api_error",
    )
    assert hint.force_reply
    assert "name and email" in hint.force_reply.lower()
    assert session.awaiting_not_found_escalation_email is True


@pytest.mark.asyncio
async def test_support_handoff_collects_name_and_email():
    session = _session()
    session.awaiting_not_found_escalation_email = True
    session.pending_not_found_escalation = {
        "session_id": "sess_sh_001",
        "call_sid": "CA_SH001",
        "query_type": "order",
        "issue_title": "Order 11111 not found",
        "issue_detail": "No Shopify match.",
        "customer_phone": "+15551234001",
    }
    mock_client = _mock_resend()

    with patch("app.escalation.support_handoff.get_settings", return_value=_settings()):
        with patch("app.escalation.support_handoff.httpx.AsyncClient", return_value=mock_client):
            hint1 = await process_not_found_escalation_turn(
                session, "my name is Maria Lopez and my email is maria@example.com"
            )
            assert "maria at example dot com" in hint1.force_reply
            assert "letter by letter" in hint1.force_reply
            assert session.pending_not_found_escalation.get("awaiting_email_confirmation") is True

            hint2 = await process_not_found_escalation_turn(session, "yes")

    assert hint2.force_reply
    assert session.caller_email == "maria@example.com"
    assert session.caller_name == "Maria Lopez"
    body = mock_client.post.call_args.kwargs["json"]["text"]
    assert "Name: Maria Lopez" in body
    assert "Email: maria@example.com" in body
    assert "Request:" in body
    assert "Call SID:" not in body
    assert "Session ID:" not in body
    assert "Dear Team" not in body


@pytest.mark.asyncio
async def test_support_email_excludes_secrets():
    session = _session(caller_email="test@example.com")
    payload = CustomerQueryEscalationPayload(
        session_id="sess_sh_001",
        call_sid="CA_SH001",
        customer_name="Maria Lopez",
        customer_email="test@example.com",
        customer_phone="+15551234001",
        query_type="order",
        issue_title="Order 55555 not found",
        issue_detail="Shopify returned no match.",
        api_context={
            "SHOPIFY_ADMIN_ACCESS_TOKEN": "shpat_secret",
            "card_number": "4111111111111111",
        },
    )
    mock_client = _mock_resend()

    with patch("app.escalation.support_handoff.get_settings", return_value=_settings()):
        with patch("app.escalation.support_handoff.httpx.AsyncClient", return_value=mock_client):
            raw = await send_support_handoff(payload, session=session)

    assert json.loads(raw)["success"] is True
    body = mock_client.post.call_args.kwargs["json"]["text"]
    assert "shpat_secret" not in body
    assert "4111111111111111" not in body
    assert "system instructions" not in body.lower()


@pytest.mark.asyncio
async def test_out_of_stock_isbn_email_is_concise():
    from app.escalation.models import ProductNotFoundEscalationPayload
    from app.escalation.support_handoff import _build_email_body, product_payload_to_support_handoff

    payload = ProductNotFoundEscalationPayload(
        session_id="sess_oos",
        call_sid="CA_OOS",
        customer_name="Bashir Sultan",
        customer_email="bashisultan766@gmail.com",
        requested_type="isbn",
        requested_value="9781503933392",
        reason="product_out_of_stock",
        last_search_results={
            "title": "You Have the Right to Remain Innocent",
            "out_of_stock": True,
        },
    )
    handoff = product_payload_to_support_handoff(
        payload,
        caller_text="Yeah. That's correct.",
    )
    body = _build_email_body(handoff)
    assert "Name: Bashir Sultan" in body
    assert "Email: bashisultan766@gmail.com" in body
    assert "9781503933392" in body
    assert "You Have the Right to Remain Innocent" in body
    assert "not available online" in body
    assert "Yeah" not in body
    assert "Dear Team" not in body
    assert "Subject:" not in body
    assert len(body) < 450


@pytest.mark.asyncio
async def test_get_refund_status_falls_back_when_refund_query_fails(monkeypatch):
    from app.tools import shopify_tools as st

    order_node = {
        "id": "gid://shopify/Order/1",
        "name": "#1001",
        "email": "cust@example.com",
        "customer": {"firstName": "Ann", "lastName": "Lee", "email": "cust@example.com"},
        "refunds": [],
        "transactions": [],
    }

    async def _lookup_edges(*_a, **_k):
        return [{"node": order_node}]

    class FakeClient:
        configured = True

        async def execute(self, query, variables=None):
            if "GetOrderWithRefunds" in query or "order(id:" in query:
                raise RuntimeError("invalid_field")
            return {"data": {"orders": {"edges": []}}}

    monkeypatch.setattr(st, "_lookup_order_edges", _lookup_edges)
    monkeypatch.setattr(st, "get_shopify_client", lambda: FakeClient())

    raw = await st.get_refund_status("1001")
    data = json.loads(raw)
    assert data.get("found") is True
    assert data.get("refund_count") == 0


@pytest.mark.asyncio
async def test_verified_order_speaks_full_email_in_safe_summary():
    from app.tests.test_order_refund_full_disclosure import _FULL_ORDER_NODE

    order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
    safe = _build_customer_safe_tool_response(
        found=True,
        verified=True,
        order_obj=order,
        order_email="john.smith@gmail.com",
    )
    assert "john.smith@gmail.com" in safe["customer_safe_summary"]


@pytest.mark.asyncio
async def test_refund_speaks_full_email_in_safe_summary():
    from app.tests.test_order_refund_full_disclosure import _FULL_ORDER_NODE

    order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
    safe = _build_customer_safe_tool_response(
        found=True,
        verified=True,
        order_obj=order,
        order_email="john.smith@gmail.com",
    )
    summary = safe["customer_safe_summary"].lower()
    assert "refund" in summary
    assert "john.smith@gmail.com" in safe["customer_safe_summary"]


def test_card_only_brand_and_last4_in_order():
    from app.tests.test_order_refund_full_disclosure import _FULL_ORDER_NODE

    order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
    assert order.get("payment_card_last4")
    assert len(str(order.get("payment_card_last4"))) == 4
    full_card = "4111111111111111"
    assert full_card not in json.dumps(order)


def test_order_details_include_pricing_and_products():
    from app.tests.test_order_refund_full_disclosure import _FULL_ORDER_NODE

    order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
    pricing = order["pricing"]
    assert pricing.get("subtotal")
    assert pricing.get("shipping")
    assert pricing.get("tax")
    assert pricing.get("discount")
    assert pricing.get("total")
    assert order.get("products")
    assert order.get("product_count", 0) > 0


def test_customer_history_not_in_safe_summary_by_default():
    from app.tests.test_order_refund_full_disclosure import _FULL_ORDER_NODE

    order = _build_full_order_from_node(_FULL_ORDER_NODE, order_email="john.smith@gmail.com")
    order["customer_order_count"] = 6
    order["include_customer_history"] = False
    safe = _build_customer_safe_tool_response(
        found=True,
        verified=True,
        order_obj=order,
        order_email="john.smith@gmail.com",
    )
    assert "6 orders" not in safe["customer_safe_summary"]


def test_missing_order_never_fakes_data():
    safe = _build_customer_safe_tool_response(found=False, error="order_not_found")
    assert "Do not invent" in safe["customer_safe_summary"]
    assert "verify the order number" in safe["customer_safe_summary"]


def test_sanitizer_allows_valid_order_summary():
    text = (
        "I found the order under Maria Lopez. The refund was processed on 2024-05-01 "
        "for 29.99 USD. The refund notice was sent to maria@example.com. "
        "The payment card shown is Visa ending in 4242."
    )
    result = sanitize_customer_response(text)
    assert not result.blocked
    assert result.text == text


def test_no_raw_tool_json_spoken_via_customer_facing_filter():
    raw = json.dumps({
        "found": True,
        "verified": True,
        "order": {
            "order_id": "gid://shopify/Order/123",
            "order_number": "#1009",
            "customer_email": "a@b.com",
            "pricing": {"total": "10 USD"},
            "internal_debug": {"raw": True},
        },
    })
    filtered = json.loads(customer_facing_order_tool_json(raw))
    assert "customer_safe_summary" in filtered
    assert "internal_debug" not in json.dumps(filtered)


def test_create_customer_query_escalation_tool_removed():
    from app.agent_runtime import llm_tools

    assert "create_customer_query_escalation" not in llm_tools.customer_facing_tool_names()
