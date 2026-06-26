"""
Real-time voice fast-path fixes — outbound streaming, debounce, intent, latency.
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")

from app.agent_runtime.commerce_flow_state import (
    STATUS_AWAITING_ADD_CONFIRM,
    stage_product_candidate,
)
from app.config import Settings
from app.orchestrator.intent_router import (
    classify_intent_heuristic,
    is_fast_path_supervisor_result,
    is_vague_product_request,
    resolve_smalltalk_response,
)
from app.orchestrator.planner_agent import build_plan
from app.orchestrator.runtime import OrchestratorRuntime
from app.orchestrator.types import SupervisorResult
from app.payment.payment_state_machine import capture_payment_email, process_payment_turn
from app.state.models import SessionState
from app.voice.turn_assembler import TurnAssembler


def _session(**kwargs) -> SessionState:
    uid = uuid.uuid4().hex[:8]
    base = dict(
        session_id=f"fast-{uid}",
        call_sid=f"CA_FAST_{uid}",
        from_number="+15551234001",
        to_number="+15559990001",
    )
    base.update(kwargs)
    return SessionState(**base)


class TestOutboundStreaming:
    @pytest.mark.asyncio
    async def test_play_immediately_delivers_without_buffer_wait(self):
        from app.ws.conversation_relay_sender import (
            ConversationRelayOutbound,
            ConversationRelayStats,
        )

        captured: list[dict] = []
        stats = ConversationRelayStats()
        settings = Settings(OPENAI_API_KEY="test", DEBUG=True)

        async def capture(msg: dict):
            captured.append(msg)

        outbound = ConversationRelayOutbound(capture, settings, "CA_IMMED", stats)
        outbound.set_turn(1)

        t0 = time.monotonic()
        await outbound.engine_send({
            "type": "text",
            "token": "Sure — what title are you looking for?",
            "last": False,
            "play_immediately": True,
        })
        elapsed_ms = (time.monotonic() - t0) * 1000

        assert len(captured) == 1
        assert captured[0]["last"] is True
        assert "title" in captured[0]["token"]
        assert elapsed_ms < 50
        assert stats.responses_sent == 1

    @pytest.mark.asyncio
    async def test_progress_ack_plays_before_final_response(self):
        from app.ws.conversation_relay_sender import (
            ConversationRelayOutbound,
            ConversationRelayStats,
        )

        captured: list[dict] = []
        stats = ConversationRelayStats()
        settings = Settings(OPENAI_API_KEY="test", DEBUG=True)

        async def capture(msg: dict):
            captured.append(msg)

        outbound = ConversationRelayOutbound(capture, settings, "CA_PROG", stats)

        await outbound.engine_send({
            "type": "text",
            "token": "I'll look that up.",
            "last": False,
            "play_immediately": True,
        })
        await outbound.engine_send({
            "type": "text",
            "token": "I found Dune for twelve dollars.",
            "last": True,
            "play_immediately": True,
        })

        assert len(captured) == 2
        assert captured[0]["token"] == "I'll look that up."
        assert captured[0]["last"] is True
        assert "Dune" in captured[1]["token"]

    @pytest.mark.asyncio
    async def test_stream_single_last_true_message(self):
        from app.orchestrator.runtime import OrchestratorRuntime

        runtime = OrchestratorRuntime(settings=Settings(OPENAI_API_KEY="test"))
        captured: list[dict] = []

        async def capture(msg: dict):
            captured.append(msg)

        await runtime._stream(capture, "Hello there.")

        assert len(captured) == 1
        assert captured[0]["last"] is True
        assert captured[0].get("play_immediately") is True


class TestVagueProductFastPath:
    @pytest.mark.parametrize(
        "utterance,expected_fragment",
        [
            ("I need a book", "title, author, or ISBN"),
            ("I need a book from you", "title, author, or ISBN"),
            ("I want a book", "title, author, or ISBN"),
            ("Can I have a book", "title, author, or ISBN"),
            ("I want to buy a book", "title, author, or ISBN"),
            ("I need a magazine", "magazine name"),
            ("I need a newspaper", "newspaper"),
            ("I want to place an order", "what item"),
        ],
    )
    def test_never_needs_supervisor_llm(self, utterance, expected_fragment):
        result = classify_intent_heuristic(utterance, _session())
        assert result.intent == "product_request_clarification"
        assert result.confidence >= 0.99
        assert result.needs_tools is False
        assert result.needs_planner is False
        assert expected_fragment.lower() in (result.clarifying_question or "").lower()
        assert is_fast_path_supervisor_result(result)

    def test_planner_skips_shopify_on_vague(self):
        sup = classify_intent_heuristic("I need a book", _session())
        plan = build_plan(sup, "I need a book", _session())
        assert plan.steps == []
        assert "title" in plan.customer_message.lower()

    def test_specific_title_still_searches(self):
        result = classify_intent_heuristic(
            "I'm looking for Stephen King It", _session()
        )
        assert result.intent == "product_search"
        assert result.needs_tools is True
        assert not is_vague_product_request("I'm looking for Stephen King It")


class TestYesNoActiveWorkflow:
    def test_yes_not_smalltalk_during_email_confirm(self):
        session = _session(
            awaiting_payment_email_confirmation=True,
            payment_flow_status="awaiting_email_confirmation",
            pending_payment_email="test@example.com",
        )
        result = classify_intent_heuristic("yes", session)
        assert result.reason == "active_workflow_yes_no"
        assert result.intent != "smalltalk"

    @pytest.mark.asyncio
    async def test_yes_confirms_email_via_payment_fsm(self):
        session = _session(payment_flow_status="awaiting_email")
        capture_payment_email(session, "buyer@example.com")
        hint = process_payment_turn(session, "yes that's correct")
        assert hint.email_confirmed or hint.force_reply

    def test_yes_not_smalltalk_during_commerce(self):
        session = _session(
            commerce_flow_status=STATUS_AWAITING_ADD_CONFIRM,
            awaiting_product_confirmation=True,
            commerce_pending_candidate={"title": "Dune", "variant_id": "v1"},
        )
        result = classify_intent_heuristic("yes", session)
        assert result.reason == "active_workflow_yes_no"

    @pytest.mark.asyncio
    async def test_yes_adds_book_via_commerce_fsm(self):
        session = _session()
        stage_product_candidate(session, {
            "title": "Dune",
            "variant_id": "gid://shopify/ProductVariant/1",
            "price": "12.00",
            "available": True,
        })
        session.commerce_flow_status = STATUS_AWAITING_ADD_CONFIRM
        session.commerce_pending_quantity = 1

        from app.agent_runtime.commerce_flow_state import process_commerce_turn

        hint = process_commerce_turn(session, "yes")
        assert hint.force_reply
        assert "added" in hint.force_reply.lower()


class TestDebounceOptimization:
    @pytest.mark.asyncio
    async def test_hello_emits_immediately(self):
        asm = TurnAssembler(settings=Settings(VOICE_TURN_ASSEMBLER_DEBOUNCE_MS=250))
        emitted: list[str] = []

        async def on_emit(turn):
            emitted.append(turn.text)

        held = await asm.ingest("Hello", on_emit, call_sid="CA1")
        assert held is False
        assert emitted == ["Hello"]

    @pytest.mark.asyncio
    async def test_vague_product_emits_immediately(self):
        asm = TurnAssembler(settings=Settings(VOICE_TURN_ASSEMBLER_DEBOUNCE_MS=250))
        emitted: list[str] = []

        async def on_emit(turn):
            emitted.append(turn.text)

        held = await asm.ingest("I need a book", on_emit, call_sid="CA1")
        assert held is False
        assert emitted == ["I need a book"]

    @pytest.mark.asyncio
    async def test_yes_emits_immediately(self):
        asm = TurnAssembler(settings=Settings(VOICE_TURN_ASSEMBLER_DEBOUNCE_MS=250))
        emitted: list[str] = []

        async def on_emit(turn):
            emitted.append(turn.text)

        held = await asm.ingest("yes", on_emit, call_sid="CA1")
        assert held is False
        assert emitted == ["yes"]

    @pytest.mark.asyncio
    async def test_isbn_holds_until_complete(self):
        asm = TurnAssembler(settings=Settings(VOICE_TURN_ASSEMBLER_DEBOUNCE_MS=250))
        emitted: list[str] = []

        async def on_emit(turn):
            emitted.append(turn.text)

        held = await asm.ingest("978", on_emit, call_sid="CA_ISBN")
        assert held is True
        assert emitted == []

    @pytest.mark.asyncio
    async def test_email_holds_until_complete(self):
        asm = TurnAssembler(settings=Settings(VOICE_TURN_ASSEMBLER_DEBOUNCE_MS=250))
        emitted: list[str] = []

        async def on_emit(turn):
            emitted.append(turn.text)

        held = await asm.ingest("john at", on_emit, call_sid="CA_EMAIL")
        assert held is True
        assert emitted == []


class TestDoubleGreeting:
    def test_twiml_greeting_shortens_smalltalk(self):
        msg = resolve_smalltalk_response(
            "Hello",
            twiml_greeting_already=True,
        )
        assert "SureShot Books" not in msg
        assert "What can I help" in msg

    def test_without_twiml_includes_brand(self):
        msg = resolve_smalltalk_response("Hello", twiml_greeting_already=False)
        assert "SureShot Books" in msg

    @pytest.mark.asyncio
    async def test_composer_respects_twiml_greeting(self):
        from app.orchestrator.response_composer import compose_response
        from app.orchestrator.types import OrchestratorTurnContext

        session = _session(twiml_greeting_spoken=True)
        ctx = OrchestratorTurnContext(
            user_text="Hello",
            supervisor=SupervisorResult(intent="smalltalk", reason="greeting"),
        )
        spoken = await compose_response(
            session, ctx, settings=Settings(OPENAI_API_KEY="test")
        )
        assert "SureShot Books" not in spoken
        assert "What can I help" in spoken


class TestLatencyAssertions:
    @pytest.mark.asyncio
    async def test_hello_under_50ms_no_openai(self):
        runtime = OrchestratorRuntime(settings=Settings(OPENAI_API_KEY="test-key"))
        session = _session(twiml_greeting_spoken=True)
        send = AsyncMock()

        with patch(
            "app.orchestrator.supervisor_agent._supervisor_llm",
            new_callable=AsyncMock,
        ) as mock_llm:
            t0 = time.monotonic()
            await runtime.handle_turn(session, "Hello", send)
            elapsed_ms = (time.monotonic() - t0) * 1000

        mock_llm.assert_not_called()
        assert elapsed_ms < 50
        assert send.await_count >= 1

    @pytest.mark.asyncio
    async def test_i_need_a_book_under_50ms_no_openai_no_shopify(self):
        runtime = OrchestratorRuntime(settings=Settings(OPENAI_API_KEY="test-key"))
        session = _session()
        send = AsyncMock()

        with patch(
            "app.orchestrator.supervisor_agent._supervisor_llm",
            new_callable=AsyncMock,
        ) as mock_llm, patch(
            "app.orchestrator.parallel_executor.execute_plan",
            new_callable=AsyncMock,
        ) as mock_tools:
            t0 = time.monotonic()
            await runtime.handle_turn(session, "I need a book", send)
            elapsed_ms = (time.monotonic() - t0) * 1000

        mock_llm.assert_not_called()
        mock_tools.assert_not_called()
        assert elapsed_ms < 50

    @pytest.mark.asyncio
    async def test_yes_email_fsm_under_50ms(self):
        runtime = OrchestratorRuntime(settings=Settings(OPENAI_API_KEY="test-key"))
        session = _session(payment_flow_status="awaiting_email")
        capture_payment_email(session, "buyer@example.com")
        send = AsyncMock()

        with patch(
            "app.orchestrator.supervisor_agent._supervisor_llm",
            new_callable=AsyncMock,
        ) as mock_llm:
            t0 = time.monotonic()
            await runtime.handle_turn(session, "yes", send)
            elapsed_ms = (time.monotonic() - t0) * 1000

        mock_llm.assert_not_called()
        assert elapsed_ms < 50
