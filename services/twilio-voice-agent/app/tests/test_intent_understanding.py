"""Intent understanding — cancellation, complaints, unclear speech, support email format."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent_runtime.not_found_escalation_flow import try_cancellation_support_handoff
from app.config import Settings
from app.escalation.models import CustomerQueryEscalationPayload
from app.escalation.support_handoff import _build_email_body, send_support_handoff
from app.runtime.fast_classifier import (
    _is_cancellation_request,
    _needs_intent_clarification,
    classify,
)
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="intent",
        call_sid="CA_INTENT001",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


class TestCancellationIntent:
    def test_detects_messy_cancellation_phrases(self):
        assert _is_cancellation_request("I need to cancel my order please")
        assert _is_cancellation_request("can you cancel cancellation for order")
        assert _is_cancellation_request("I don't want the order anymore")
        assert not _is_cancellation_request("where is my order")

    def test_classifier_routes_cancellation_not_order_lookup(self):
        result = classify("I want to cancel my order", _session())
        assert result.is_cancellation_request
        assert result.reason == "cancellation_request"
        assert not result.is_order_lookup

    @pytest.mark.asyncio
    async def test_cancellation_stages_support_handoff(self):
        session = _session()
        hint = await try_cancellation_support_handoff(
            session, "I need to cancel order 63482",
        )
        assert hint.force_reply
        assert "name and email" in hint.force_reply.lower()
        assert session.awaiting_not_found_escalation_email is True
        pending = session.pending_not_found_escalation or {}
        assert pending.get("query_type") == "cancellation"


class TestUnclearSpeech:
    def test_filler_triggers_clarification(self):
        assert _needs_intent_clarification("um")
        assert _needs_intent_clarification("help")

    def test_classifier_asks_intent_on_vague_help(self):
        result = classify("help", _session())
        assert result.action == "instant"
        assert result.reason == "unclear_intent"
        assert "cancel an order" in result.instant_reply.lower()


class TestSupportEmailFormat:
    def test_email_body_name_email_request_only(self):
        body = _build_email_body(
            CustomerQueryEscalationPayload(
                session_id="hidden",
                call_sid="CA_HIDDEN",
                customer_name="Jane Doe",
                customer_email="jane@example.com",
                customer_phone="+15551230000",
                query_type="cancellation",
                issue_title="Order cancellation",
                issue_detail="Customer wants to cancel order 12345.",
                what_customer_asked="Please cancel my order",
            ),
            conversation_summary="Caller asked to cancel before shipment.",
        )
        assert "Customer name: Jane Doe" in body
        assert "Customer email: jane@example.com" in body
        assert "Customer request:" in body
        assert "cancel" in body.lower()
        assert "Call SID" not in body
        assert "Session ID" not in body
        assert "+1555" not in body

    @pytest.mark.asyncio
    async def test_send_support_handoff_email_format(self):
        session = _session(caller_name="Jane Doe")
        payload = CustomerQueryEscalationPayload(
            session_id="sess",
            call_sid="CA123",
            customer_name="Jane Doe",
            customer_email="jane@example.com",
            query_type="cancellation",
            issue_title="Cancellation",
            issue_detail="Cancel order 999.",
        )
        mock_resp = MagicMock(status_code=200)
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        settings = Settings(
            SUPPORT_EMAIL="support@test.com",
            RESEND_API_KEY="re_test",
            SUPPORT_ESCALATION_ENABLED=True,
        )

        with patch("app.escalation.support_handoff.get_settings", return_value=settings):
            with patch("app.escalation.support_handoff.httpx.AsyncClient", return_value=mock_client):
                with patch(
                    "app.escalation.conversation_summarizer.summarize_conversation_for_support",
                    new_callable=AsyncMock,
                    return_value=("Summary text", ""),
                ):
                    raw = await send_support_handoff(payload, session=session)

        assert json.loads(raw)["success"] is True
        body = mock_client.post.call_args.kwargs["json"]["text"]
        assert "Customer request:" in body
        assert "Call SID" not in body
