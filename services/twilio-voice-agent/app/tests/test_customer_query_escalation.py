"""
Support handoff — order not found, LLM summary, canonical email path.
"""
from __future__ import annotations

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
async def test_order_not_found_does_not_auto_escalate():
    session = _session()
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


@pytest.mark.asyncio
async def test_order_not_found_does_not_send_with_profile_email():
    session = _session(confirmed_email="maria@example.com", caller_email="maria@example.com")
    mock_client = _mock_resend()

    with patch(
        "app.agent_runtime.order_parallel_enrichment.enrich_order_parallel",
        new_callable=AsyncMock,
    ) as mock_enrich:
        mock_enrich.return_value = MagicMock(
            order={"found": False, "error_code": "order_not_found"},
            suggested_response="I couldn't find that order in our system.",
        )
        with patch("app.escalation.support_handoff.get_settings", return_value=_settings()):
            with patch(
                "app.escalation.support_handoff.httpx.AsyncClient",
                return_value=mock_client,
            ):
                hint = await try_order_enrichment_short_circuit(session, "22399")

    assert hint and hint.force_reply
    mock_client.post.assert_not_awaited()


@pytest.mark.asyncio
async def test_send_support_handoff_short_professional_body():
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

    with patch("app.escalation.support_handoff.get_settings", return_value=_settings()):
        with patch(
            "app.escalation.support_handoff.httpx.AsyncClient",
            return_value=mock_client,
        ):
            with patch(
                "app.escalation.conversation_summarizer.summarize_conversation_for_support",
                new_callable=AsyncMock,
                return_value=(
                    "Subject: Long LLM letter. Dear Team, please handle this request...",
                    "",
                ),
            ):
                raw = await send_support_handoff(payload, session=session)

    data = json.loads(raw)
    assert data["success"] is True
    body = mock_client.post.call_args.kwargs["json"]["text"]
    assert "Name: Maria Lopez" in body
    assert "Email: test@example.com" in body
    assert "Request:" in body
    assert "Order 55555 not found" in body
    assert "Call SID:" not in body
    assert "Session ID:" not in body
    assert "Dear Backend Team" not in body
    assert "Dear Team" not in body
    assert "Subject:" not in body


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

    with patch("app.escalation.support_handoff.get_settings", return_value=_settings()):
        with patch(
            "app.escalation.support_handoff.httpx.AsyncClient",
            return_value=mock_client,
        ):
            hint1 = await process_not_found_escalation_turn(
                session, "my email is maria@example.com"
            )
            assert "maria at example dot com" in hint1.force_reply
            assert "Letter by letter" in hint1.force_reply
            hint2 = await process_not_found_escalation_turn(session, "yes")

    assert hint2.force_reply
    assert session.awaiting_not_found_escalation_email is False
    assert hint2.extra_tool_result and hint2.extra_tool_result.success
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
    assert "support team" in hint.force_reply.lower() or "forward" in hint.force_reply.lower()
    assert session.awaiting_not_found_escalation_email is True
