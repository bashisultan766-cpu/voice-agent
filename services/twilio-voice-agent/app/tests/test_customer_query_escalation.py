"""
Customer query escalation — order not found, LLM summary, backend email.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent_runtime.customer_query_escalation_flow import (
    process_customer_query_escalation_turn,
    try_escalate_unresolved_query,
)
from app.agent_runtime.order_flow_state import try_order_enrichment_short_circuit
from app.config import Settings
from app.escalation.customer_query_escalation import create_customer_query_escalation
from app.escalation.models import CustomerQueryEscalationPayload
from app.escalation.product_not_found_escalation import _STORE
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="sess_cq_001",
        call_sid="CA_CQ001",
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


@pytest.mark.asyncio
async def test_order_not_found_asks_for_email():
    session = _session()
    with patch(
        "app.agent_runtime.order_parallel_enrichment.enrich_order_parallel",
        new_callable=AsyncMock,
    ) as mock_enrich:
        mock_enrich.return_value = MagicMock(
            order={"found": False, "message": "No matching order found."},
            suggested_response="",
        )
        hint = await try_order_enrichment_short_circuit(session, "order 22399")

    assert hint and hint.force_reply
    assert "email" in hint.force_reply.lower()
    assert "backend team" in hint.force_reply.lower()
    assert session.awaiting_not_found_escalation_email is True
    pending = session.pending_not_found_escalation
    assert pending.get("query_type") == "order"
    assert "22399" in pending.get("issue_title", "")


@pytest.mark.asyncio
async def test_order_not_found_sends_with_email():
    session = _session(confirmed_email="maria@example.com")
    mock_client = _mock_resend()

    with patch(
        "app.agent_runtime.order_parallel_enrichment.enrich_order_parallel",
        new_callable=AsyncMock,
    ) as mock_enrich:
        mock_enrich.return_value = MagicMock(
            order={"found": False},
            suggested_response="",
        )
        with patch("app.escalation.customer_query_escalation.get_settings", return_value=_settings()):
            with patch(
                "app.escalation.customer_query_escalation.httpx.AsyncClient",
                return_value=mock_client,
            ):
                with patch(
                    "app.escalation.customer_query_escalation.summarize_conversation_for_support",
                    new_callable=AsyncMock,
                    return_value=("Customer needs order 22399 located manually.", "user: order 22399"),
                ):
                    hint = await try_order_enrichment_short_circuit(session, "22399")

    assert hint and "backend team" in hint.force_reply.lower()
    mock_client.post.assert_awaited_once()
    email_json = mock_client.post.call_args.kwargs["json"]
    assert email_json["to"] == ["jessica@sureshotbooks.com"]
    assert email_json["reply_to"] == "maria@example.com"
    body = email_json["text"]
    assert "Maria Lopez" in body
    assert "maria@example.com" in body
    assert "22399" in body
    assert "Customer needs order 22399" in body


@pytest.mark.asyncio
async def test_create_customer_query_escalation_includes_llm_summary():
    session = _session(caller_email="test@example.com")
    session.history = [
        {"role": "user", "content": "Where is my order 55555?"},
        {"role": "assistant", "content": "Let me check that."},
    ]
    payload = CustomerQueryEscalationPayload(
        session_id="sess_cq_001",
        call_sid="CA_CQ001",
        customer_name="Maria Lopez",
        customer_email="test@example.com",
        customer_phone="+15551234001",
        query_type="order",
        issue_title="Order 55555 not found",
        issue_detail="Shopify returned no match.",
    )
    mock_client = _mock_resend()

    with patch("app.escalation.customer_query_escalation.get_settings", return_value=_settings()):
        with patch(
            "app.escalation.customer_query_escalation.httpx.AsyncClient",
            return_value=mock_client,
        ):
            with patch(
                "app.escalation.customer_query_escalation.summarize_conversation_for_support",
                new_callable=AsyncMock,
                return_value=("LLM summary of the call.", "user: Where is my order"),
            ):
                raw = await create_customer_query_escalation(payload, session=session)

    data = json.loads(raw)
    assert data["success"] is True
    body = mock_client.post.call_args.kwargs["json"]["text"]
    assert "LLM summary of the call." in body
    assert "Maria Lopez" in body
    assert "test@example.com" in body


@pytest.mark.asyncio
async def test_email_capture_on_followup_turn():
    session = _session()
    session.awaiting_not_found_escalation_email = True
    session.pending_not_found_escalation = {
        "session_id": "sess_cq_001",
        "call_sid": "CA_CQ001",
        "query_type": "order",
        "issue_title": "Order 11111 not found",
        "issue_detail": "No Shopify match.",
        "customer_name": "Maria Lopez",
        "customer_phone": "+15551234001",
    }
    mock_client = _mock_resend()

    with patch("app.escalation.customer_query_escalation.get_settings", return_value=_settings()):
        with patch(
            "app.escalation.customer_query_escalation.httpx.AsyncClient",
            return_value=mock_client,
        ):
            with patch(
                "app.escalation.customer_query_escalation.summarize_conversation_for_support",
                new_callable=AsyncMock,
                return_value=("Summary", "transcript"),
            ):
                hint = await process_customer_query_escalation_turn(
                    session, "my email is maria@example.com"
                )

    assert hint.force_reply
    assert session.awaiting_not_found_escalation_email is False
    assert hint.extra_tool_result and hint.extra_tool_result.success
    assert mock_client.post.await_count == 1


@pytest.mark.asyncio
async def test_try_escalate_unresolved_query_no_fake_data_message():
    session = _session()
    hint = await try_escalate_unresolved_query(
        session,
        caller_text="I need info on product XYZ-999",
        query_type="product",
        issue_title="Product XYZ-999 not in catalog",
        issue_detail="Catalog search returned zero results.",
    )
    assert "couldn't find" in hint.force_reply.lower() or "backend team" in hint.force_reply.lower()
    assert session.awaiting_not_found_escalation_email is True
