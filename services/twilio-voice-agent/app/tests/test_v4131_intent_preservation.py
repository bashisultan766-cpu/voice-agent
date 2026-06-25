"""v4.13.1 — Intent preservation and ISBN mode emergency fix tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


class TestActionGateIntentPreservation:
    def test_name_question_stays_identity(self):
        from app.agent_runtime.action_gate import evaluate_action_gate
        from app.agent_runtime.types import SupervisorDecision

        r = evaluate_action_gate(
            call_sid="CA4131",
            caller_text="What is your name?",
            supervisor=SupervisorDecision(user_intent="identity"),
            pipeline_intent="identity_question",
        )
        assert r.allowed is True
        assert r.semantic_intent == "identity_question"
        assert r.product_search_blocked is False

    def test_name_variants_stay_identity(self):
        from app.agent_runtime.action_gate import evaluate_action_gate
        from app.agent_runtime.types import SupervisorDecision

        for text in (
            "Hello. What's what is your name?",
            "I'm asking about what is your name.",
        ):
            r = evaluate_action_gate(
                call_sid="CA4131",
                caller_text=text,
                supervisor=SupervisorDecision(user_intent="identity"),
                pipeline_intent="identity_question",
            )
            assert r.semantic_intent == "identity_question", text

    def test_product_search_blocked_preserves_identity(self):
        from app.agent_runtime.action_gate import evaluate_action_gate
        from app.agent_runtime.types import SupervisorDecision

        r = evaluate_action_gate(
            call_sid="CA4131",
            caller_text="What is your name?",
            supervisor=SupervisorDecision(user_intent="book_search"),
            pipeline_intent="product_search",
        )
        assert r.allowed is False
        assert r.product_search_blocked is True
        assert r.semantic_intent == "identity_question"

    def test_company_misroute_still_blocks(self):
        from app.agent_runtime.action_gate import evaluate_action_gate
        from app.agent_runtime.types import SupervisorDecision

        r = evaluate_action_gate(
            call_sid="CA4131",
            caller_text="Your short short book.",
            supervisor=SupervisorDecision(user_intent="book_search"),
            pipeline_intent="product_search",
        )
        assert r.allowed is False
        assert r.semantic_intent == "company_question"


class TestIdentityDeterministicResponse:
    @pytest.mark.asyncio
    async def test_exact_identity_response(self):
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.state.models import SessionState
        from app.workers.base import WorkerBundle

        session = SessionState(
            session_id="s4131i",
            call_sid="CA00004131I",
            from_number="+15550004131",
            to_number="+15559998888",
        )
        composer = get_final_composer()
        text, source = await composer.compose(
            session,
            "What is your name?",
            SupervisorDecision(user_intent="identity"),
            IntentResult(intent="identity_question", confidence=0.96),
            MemoryPacket(),
            FactPacket(),
            WorkerBundle(),
        )
        assert source == "deterministic"
        assert text == "My name is Eric. I'm with SureShot Books."
        assert "orders, shipping" not in text

    @pytest.mark.asyncio
    async def test_company_not_used_for_name(self):
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.state.models import SessionState
        from app.workers.base import WorkerBundle

        session = SessionState(
            session_id="s4131c",
            call_sid="CA00004131C",
            from_number="+15550004131",
            to_number="+15559998888",
        )
        composer = get_final_composer()
        text, _ = await composer.compose(
            session,
            "What is your name?",
            SupervisorDecision(user_intent="identity"),
            IntentResult(intent="identity_question", confidence=0.96),
            MemoryPacket(),
            FactPacket(),
            WorkerBundle(),
            action_gate={
                "allowed": True,
                "reason": "identity_turn",
                "semantic_intent": "identity_question",
                "product_search_blocked": False,
            },
        )
        assert text == "My name is Eric. I'm with SureShot Books."


class TestIsbnModeEmergencyFix:
    def test_model_question_stays_normal(self):
        from app.voice.turn_taking import should_collect_isbn

        cases = (
            "Why are you not using a 11 model?",
            "You're not using LLM",
            "GPT 4o model",
            "version 4.13",
        )
        for text in cases:
            assert should_collect_isbn(text) is False, text

    def test_explicit_isbn_context(self):
        from app.voice.turn_taking import should_collect_isbn

        assert should_collect_isbn("The ISBN number is 9 7 8 0 4 4 1 1 7 2 7 1 9")
        assert should_collect_isbn(
            "9780441172719",
            book_collection=True,
        )

    @pytest.mark.asyncio
    async def test_turn_assembler_no_isbn_for_model(self):
        import asyncio
        from app.tests.test_v49_turn_assembler import _settings
        from app.voice.turn_assembler import TurnAssembler

        asm = TurnAssembler(settings=_settings())
        emitted = []

        async def _emit(text):
            emitted.append(text)

        held = await asm.ingest(
            "Why are you not using a 11 model?",
            _emit,
            call_sid="CA4131M",
        )
        assert asm._state.mode == "normal"
        assert held is True
        await asyncio.sleep(0.25)
        assert len(emitted) == 1
        last_text = emitted[0].text if hasattr(emitted[0], "text") else emitted[0]
        assert "model" in last_text.lower()
