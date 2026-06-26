"""v4.32 — order parallel enrichment, facility knowledge, yes never silent."""
from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.llm_tool_runtime import LLMToolRuntime
from app.agent_runtime.order_flow_state import (
    extract_order_number,
    order_intent_detected,
    process_order_turn,
    try_order_enrichment_short_circuit,
)
from app.agent_runtime.order_parallel_enrichment import compose_order_voice_reply, enrich_order_parallel
from app.agent_runtime.yes_engagement import is_bare_yes, yes_engagement_fallback, yes_engagement_reply
from app.facility.knowledge_context import build_facility_knowledge_block
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="v432",
        call_sid="CA_V432TEST",
        from_number="+15551234000",
        to_number="+15559999999",
        **kwargs,
    )


class TestOrderIntent:
    def test_detects_tracking_question(self):
        assert order_intent_detected("Where is my order? Has it been delivered?")

    def test_extracts_order_number(self):
        assert extract_order_number("My order number is 4521") == "4521"
        assert extract_order_number("4 5 2 1") == "4521"

    def test_asks_for_order_number(self):
        session = _session()
        hint = process_order_turn(session, "Can you check my order status?")
        assert hint.force_reply
        assert "order number" in hint.force_reply.lower()


class TestYesNeverSilent:
    def test_bare_yes_empty_cart_gets_fallback(self):
        session = _session()
        assert is_bare_yes("yes")
        reply = yes_engagement_reply(session)
        assert reply
        assert "book" in reply.lower() or "order" in reply.lower()

    def test_fallback_always_non_empty(self):
        assert yes_engagement_fallback(_session())


class TestFacilityKnowledge:
    def test_knowledge_block_mentions_guidelines(self):
        block = build_facility_knowledge_block(_session())
        assert "FACILITY GUIDELINES" in block
        assert "facility" in block.lower()


class TestOrderParallelEnrichment:
    def test_compose_merges_order_and_refund(self):
        text = compose_order_voice_reply(
            {
                "found": True,
                "order_number": "#4521",
                "status": "PAID",
                "fulfillment_status": "FULFILLED",
                "suggested_response": "Order #4521 is PAID and FULFILLED.",
                "payment_card_last4": "4242",
            },
            {"refund_count": 1, "suggested_response": "One refund was issued."},
        )
        assert "4521" in text
        assert "refund" in text.lower()

    @pytest.mark.asyncio
    async def test_parallel_enrichment(self):
        session = _session(verified_phone=True)
        order_payload = json.dumps({
            "found": True,
            "order_number": "#4521",
            "status": "PAID",
            "fulfillment_status": "FULFILLED",
            "items": ["1x Test Book"],
            "email_masked": "b***@gmail.com",
            "payment_card_last4": "4242",
            "suggested_response": "Order #4521 is PAID and FULFILLED.",
        })
        refund_payload = json.dumps({
            "refund_count": 0,
            "suggested_response": "No refunds on this order.",
        })

        with patch(
            "app.tools.shopify_tools.lookup_order",
            new_callable=AsyncMock,
            return_value=order_payload,
        ), patch(
            "app.tools.shopify_tools.get_refund_status",
            new_callable=AsyncMock,
            return_value=refund_payload,
        ):
            result = await enrich_order_parallel(session, "4521", phone="+15551234000")

        assert result.verified
        assert "4521" in result.suggested_response


class TestOrderShortCircuitRuntime:
    @pytest.mark.asyncio
    async def test_order_number_skips_openai(self):
        runtime = LLMToolRuntime()
        session = _session(verified_phone=True)
        order_payload = json.dumps({
            "found": True,
            "order_number": "#4521",
            "status": "PAID",
            "fulfillment_status": "FULFILLED",
            "items": ["1x Book"],
            "suggested_response": "Order #4521 is on the way.",
        })
        refund_payload = json.dumps({"refund_count": 0})

        async def boom(*_a, **_k):
            raise AssertionError("OpenAI must not run when order enrichment short-circuits")

        runtime._complete = boom  # type: ignore[method-assign]

        with patch(
            "app.tools.shopify_tools.lookup_order",
            new_callable=AsyncMock,
            return_value=order_payload,
        ), patch(
            "app.tools.shopify_tools.get_refund_status",
            new_callable=AsyncMock,
            return_value=refund_payload,
        ):
            async def send(_msg):
                pass

            out = await runtime.handle_turn(session, "4 5 2 1", send, assembled_turn_mode="order")

        assert "4521" in out.response_text

    @pytest.mark.asyncio
    async def test_bare_yes_never_silent(self):
        runtime = LLMToolRuntime()
        session = _session()

        async def boom(*_a, **_k):
            raise AssertionError("OpenAI must not run on bare yes")

        runtime._complete = boom  # type: ignore[method-assign]

        async def send(_msg):
            pass

        out = await runtime.handle_turn(session, "yes", send)
        assert out.response_text
