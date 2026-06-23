"""v4.14 — Identity questions must never produce company response."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


class TestMainLlmAgentIdentityDirect:
    """MainLLMAgent must answer identity questions with Eric name, not company."""

    @pytest.mark.asyncio
    async def test_what_is_your_name_direct_answer(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        # Mock settings with invalid key — fast_path should handle identity
        from app.config import get_settings
        s = get_settings()

        # Test with no OpenAI call needed for identity (fast path in decide_and_answer)
        decision = await decide_and_answer(
            user_turn="What is your name?",
            settings=s,
        )
        assert decision["intent"] == "identity"
        assert decision["response_mode"] == "direct_answer"
        assert decision["direct_answer"] == "My name is Eric. I'm with SureShot Books."
        assert decision["tool_categories"] == []

    @pytest.mark.asyncio
    async def test_asking_about_name_variants(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        for text in (
            "I'm asking about your name.",
            "I'm not asking about store name, what is your name?",
            "Hello. What's what is your name?",
            "Tell me your name please.",
        ):
            decision = await decide_and_answer(
                user_turn=text,
                settings=s,
            )
            assert decision["intent"] == "identity", f"Failed for: {text}"
            assert decision["response_mode"] == "direct_answer", f"Failed for: {text}"
            assert "My name is Eric" in decision["direct_answer"], f"Failed for: {text}"
            assert "shipping, refunds" not in decision["direct_answer"].lower(), f"Failed for: {text}"
            assert decision["tool_categories"] == [], f"Failed for: {text}"

    @pytest.mark.asyncio
    async def test_how_are_you_small_talk(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="How are you?",
            settings=s,
        )
        assert decision["intent"] == "small_talk"
        assert decision["response_mode"] == "direct_answer"
        assert decision["tool_categories"] == []

    @pytest.mark.asyncio
    async def test_are_you_sureshot(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="Are you SureShot Books?",
            settings=s,
        )
        assert decision["intent"] == "company"
        assert decision["response_mode"] == "direct_answer"
        assert decision["tool_categories"] == []


class TestIdentityNeverCompanyIntegration:
    """Full integration: identity must never route through company template."""

    def test_action_gate_preserves_identity(self):
        from app.agent_runtime.action_gate import evaluate_action_gate
        from app.agent_runtime.types import SupervisorDecision

        r = evaluate_action_gate(
            call_sid="CA414I",
            caller_text="What is your name?",
            supervisor=SupervisorDecision(user_intent="identity"),
            pipeline_intent="identity_question",
        )
        assert r.allowed is True
        assert r.semantic_intent == "identity_question"
        assert r.product_search_blocked is False

    def test_action_gate_preserves_identity_variants(self):
        from app.agent_runtime.action_gate import evaluate_action_gate
        from app.agent_runtime.types import SupervisorDecision

        for text in (
            "I'm asking about your name.",
            "I'm not asking about store name, what is your name?",
        ):
            r = evaluate_action_gate(
                call_sid="CA414I",
                caller_text=text,
                supervisor=SupervisorDecision(user_intent="identity"),
                pipeline_intent="identity_question",
            )
            assert r.semantic_intent == "identity_question", text

    def test_final_composer_identity_not_company(self):
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.state.models import SessionState
        from app.workers.base import WorkerBundle

        session = SessionState(
            session_id="s414i",
            call_sid="CA0000414I",
            from_number="+1555004141",
            to_number="+15559998888",
        )

        for text in (
            "What is your name?",
            "I'm asking about your name.",
            "I'm not asking about store name, what is your name?",
        ):
            composer = get_final_composer()
            import asyncio
            resp, source = asyncio.run(composer.compose(
                session,
                text,
                SupervisorDecision(user_intent="identity"),
                IntentResult(intent="identity_question", confidence=0.96),
                MemoryPacket(),
                FactPacket(),
                WorkerBundle(),
            ))
            assert source == "deterministic"
            assert resp == "My name is Eric. I'm with SureShot Books.", f"Failed for: {text}"
            assert "shipping, refunds" not in resp.lower(), f"Failed for: {text}"


class TestDetectRuntimeMode:
    def test_main_llm_agent_mode_default(self, monkeypatch):
        monkeypatch.delenv("VOICE_AGENT_RUNTIME_MODE", raising=False)
        from app.config import Settings
        s = Settings()
        assert s.VOICE_AGENT_RUNTIME_MODE == "main_llm_agent"
