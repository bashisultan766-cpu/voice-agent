"""
Step 10 — voice latency, fast acknowledgement, deterministic shortcuts, style guard.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent_runtime.output_guardrails import apply_output_guardrails, apply_voice_style_guard
from app.config import Settings
from app.orchestrator.intent_router import classify_intent_heuristic
from app.orchestrator.planner_agent import build_plan
from app.orchestrator.progress_ack import resolve_progress_message, should_send_progress_ack
from app.orchestrator.response_composer import compose_response, should_skip_composer_llm
from app.orchestrator.runtime import OrchestratorRuntime
from app.orchestrator.supervisor_agent import run_supervisor
from app.orchestrator.types import (
    OrchestratorTurnContext,
    PlanStep,
    PlannerResult,
    SupervisorResult,
    ToolExecutionResult,
)
from app.state.models import SessionState
from app.voice.turn_assembler import TurnAssembler


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="s10",
        call_sid="CA_S10",
        from_number="+15551230001",
        to_number="+15559990001",
    )
    base.update(kwargs)
    return SessionState(**base)


class TestFastAcknowledgement:
    def test_isbn_search_ack(self):
        sup = classify_intent_heuristic("9780441172719", _session())
        plan = build_plan(sup, "9780441172719", _session())
        msg = resolve_progress_message(sup, plan, "9780441172719")
        assert msg == "Let me check that ISBN."

    def test_order_lookup_ack(self):
        sup = SupervisorResult(intent="order_status", needs_planner=True)
        plan = PlannerResult(
            steps=[PlanStep(tool="lookup_order_status", args={})],
            customer_facing_progress_message="Let me check that order.",
        )
        msg = resolve_progress_message(sup, plan)
        assert "order" in msg.lower()

    def test_facility_lookup_ack(self):
        sup = classify_intent_heuristic(
            "Does Smith State Prison allow magazines?", _session()
        )
        plan = build_plan(sup, "Does Smith State Prison allow magazines?", _session())
        msg = resolve_progress_message(sup, plan)
        assert "facility" in msg.lower()

    def test_payment_fsm_skips_generic_ack(self):
        session = _session(
            awaiting_payment_email_confirmation=True,
            payment_flow_status="awaiting_email_confirmation",
        )
        sup = SupervisorResult(intent="identity_email_collection")
        assert should_send_progress_ack(session, turn_mode="email", supervisor=sup) is False


class TestDeterministicComposer:
    @pytest.mark.asyncio
    async def test_customer_message_skips_composer_llm(self):
        ctx = OrchestratorTurnContext(
            user_text="magazines",
            supervisor=SupervisorResult(intent="facility_question"),
            tool_results=[
                ToolExecutionResult(
                    tool="check_facility_content_allowed",
                    success=True,
                    result={"customer_message": "Magazines are restricted."},
                ),
            ],
        )
        with patch(
            "app.orchestrator.response_composer._compose_llm",
            new_callable=AsyncMock,
        ) as mock_llm:
            text = await compose_response(_session(), ctx, use_llm=True)
            mock_llm.assert_not_called()
        assert "restricted" in text.lower()

    @pytest.mark.asyncio
    async def test_suggested_response_skips_composer_llm(self):
        ctx = OrchestratorTurnContext(
            user_text="faq",
            supervisor=SupervisorResult(intent="faq"),
            tool_results=[
                ToolExecutionResult(
                    tool="faq_lookup",
                    success=True,
                    result={"suggested_response": "We ship via media mail."},
                ),
            ],
        )
        with patch(
            "app.orchestrator.response_composer._compose_llm",
            new_callable=AsyncMock,
        ) as mock_llm:
            text = await compose_response(_session(), ctx, use_llm=True)
            mock_llm.assert_not_called()
        assert "media mail" in text.lower()

    def test_should_skip_composer_llm_flag(self):
        ctx = OrchestratorTurnContext(
            user_text="hi",
            supervisor=SupervisorResult(intent="smalltalk"),
            tool_results=[],
        )
        assert should_skip_composer_llm(ctx, _session()) is True


class TestSupervisorAndPlannerLLMSkip:
    @pytest.mark.asyncio
    async def test_heuristic_supervisor_skips_llm_on_high_confidence(self):
        session = _session()
        with patch(
            "app.orchestrator.supervisor_agent._supervisor_llm",
            new_callable=AsyncMock,
        ) as mock_llm:
            result = await run_supervisor(
                session,
                "9780441172719",
                use_llm=True,
                settings=Settings(OPENAI_API_KEY="test-key"),
            )
            mock_llm.assert_not_called()
        assert result.intent == "product_search"
        assert result.confidence >= 0.92

    def test_deterministic_planner_no_llm(self):
        sup = classify_intent_heuristic("9780441172719", _session())
        plan = build_plan(sup, "9780441172719", _session())
        assert plan.steps[0].tool == "search_products"


class TestDebounceOptimization:
    def test_normal_debounce_reduced(self):
        # model_construct ignores production .env (VPS may set 750ms there).
        s = Settings.model_construct(VOICE_TURN_ASSEMBLER_DEBOUNCE_MS=380)
        asm = TurnAssembler(settings=s)
        assert asm._debounce_ms("normal") == 380

    @pytest.mark.asyncio
    async def test_complete_isbn_emits_immediately(self):
        asm = TurnAssembler()
        emitted: list[str] = []

        async def on_emit(turn):
            emitted.append(turn.text)

        held = await asm.ingest("9780441172719", on_emit, call_sid="CA1")
        assert held is False
        assert emitted == ["9780441172719"]

    @pytest.mark.asyncio
    async def test_complete_email_emits_immediately(self):
        asm = TurnAssembler()
        emitted: list[str] = []

        async def on_emit(turn):
            emitted.append(turn.text)

        held = await asm.ingest("bashi at gmail dot com", on_emit, call_sid="CA1")
        assert held is False
        assert emitted

    @pytest.mark.asyncio
    async def test_yes_emits_immediately(self):
        asm = TurnAssembler()
        emitted: list[str] = []

        async def on_emit(turn):
            emitted.append(turn.text)

        held = await asm.ingest("yes", on_emit, call_sid="CA1")
        assert held is False
        assert emitted == ["yes"]

    @pytest.mark.asyncio
    async def test_order_number_emits_immediately(self):
        asm = TurnAssembler()
        emitted: list[str] = []

        async def on_emit(turn):
            emitted.append(turn.text)

        held = await asm.ingest("order number 12345", on_emit, call_sid="CA1")
        assert held is False
        assert "12345" in emitted[0]

    @pytest.mark.asyncio
    async def test_normal_speech_still_merges_fragments(self):
        asm = TurnAssembler(settings=Settings(VOICE_TURN_ASSEMBLER_DEBOUNCE_MS=380))
        emitted: list[str] = []

        async def on_emit(turn):
            emitted.append(turn.text)

        held1 = await asm.ingest("looking for", on_emit, call_sid="CA1")
        held2 = await asm.ingest("a bible", on_emit, call_sid="CA1")
        assert held1 is True
        assert held2 is True
        assert not emitted
        await asm.flush(on_emit, call_sid="CA1")
        assert emitted


class TestResponseStyleGuard:
    def test_removes_long_robotic_response(self):
        raw = (
            "As an AI, I can help you. "
            "Here is a very long explanation about policies and procedures. "
            "Another sentence follows. "
            "And yet another sentence that should be trimmed."
        )
        styled = apply_voice_style_guard(raw)
        assert styled.count(".") + styled.count("!") + styled.count("?") <= 2
        assert "as an ai" not in styled.lower()

    def test_raw_url_not_spoken(self):
        result = apply_output_guardrails(
            "Visit https://example.com/checkout for payment."
        )
        assert "http" not in result.text.lower()
        assert "https" not in result.text.lower()


class TestInterruptRecovery:
    @pytest.mark.asyncio
    async def test_interrupt_preserves_completed_tool_result(self):
        runtime = OrchestratorRuntime(settings=Settings(OPENAI_API_KEY=""))
        session = _session(cart_items=[{"title": "Dune", "quantity": 1}])
        send = AsyncMock()

        with patch(
            "app.orchestrator.runtime.run_supervisor",
            new_callable=AsyncMock,
            return_value=SupervisorResult(
                intent="cart_update", needs_tools=True, needs_planner=True, confidence=0.95
            ),
        ), patch(
            "app.orchestrator.runtime.run_planner",
            new_callable=AsyncMock,
            return_value=PlannerResult(
                steps=[PlanStep(tool="get_cart", args={})],
                customer_facing_progress_message="Let me check your cart.",
            ),
        ), patch(
            "app.orchestrator.runtime.execute_plan",
            new_callable=AsyncMock,
            return_value=[
                ToolExecutionResult(
                    tool="get_cart",
                    success=True,
                    result={"customer_message": "You have one item in your cart."},
                ),
            ],
        ):
            await runtime.handle_turn(session, "what is in my cart", send)

        assert session.cart_items
        assert send.await_count >= 1

    @pytest.mark.asyncio
    async def test_interrupt_repair_repeats_last_response(self):
        runtime = OrchestratorRuntime(settings=Settings(OPENAI_API_KEY=""))
        session = _session(last_spoken_response="Your cart has one book.")
        from app.agent_runtime.interruption_manager import record_interrupt

        record_interrupt(session.call_sid, previous_response="Your cart has one book.")
        send = AsyncMock()
        await runtime.handle_turn(session, "what?", send)
        tokens = [
            str(c[0][0].get("token", ""))
            for c in send.await_args_list
            if c[0][0].get("token")
        ]
        assert any("cart" in t.lower() for t in tokens)

    @pytest.mark.asyncio
    async def test_interrupt_does_not_lose_confirmed_email(self):
        runtime = OrchestratorRuntime(settings=Settings(OPENAI_API_KEY=""))
        session = _session(confirmed_email="test@example.com")
        from app.agent_runtime.interruption_manager import record_interrupt

        record_interrupt(session.call_sid, previous_response="Thanks.")
        send = AsyncMock()
        with patch(
            "app.orchestrator.runtime.run_supervisor",
            new_callable=AsyncMock,
            return_value=SupervisorResult(intent="smalltalk", confidence=0.9),
        ):
            await runtime.handle_turn(session, "repeat", send)
        assert session.confirmed_email == "test@example.com"
