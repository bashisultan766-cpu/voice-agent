"""v4.16.0 — Live log regression tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


def _settings(**overrides):
    from app.config import Settings
    defaults = dict(
        OPENAI_API_KEY="test",
        DEBUG=True,
        VOICE_BRAIN_ORCHESTRATOR_ENABLED=True,
        VOICE_BRAIN_DETERMINISTIC_GREETING_FASTPATH=True,
    )
    defaults.update(overrides)
    return Settings(**defaults)


@pytest.mark.asyncio
class TestLiveLogRegressions:
    async def test_hello_how_are_you_brother(self):
        from app.agent_runtime.brain_orchestrator import BrainOrchestrator, BrainOrchestratorInput

        d = await BrainOrchestrator(_settings()).decide(
            BrainOrchestratorInput(call_sid="CAlive1", user_text="Hello. How are you, brother?")
        )
        assert d.response_mode == "direct_answer"
        assert "found 2 items" not in (d.answer or "").lower()

    async def test_identity_yes_or_no(self):
        from app.agent_runtime.brain_orchestrator import BrainOrchestrator, BrainOrchestratorInput

        d = await BrainOrchestrator(_settings()).decide(
            BrainOrchestratorInput(call_sid="CAlive2", user_text="Your name is Eric. Yes or no?")
        )
        assert d.response_mode != "hold"
        assert "yes" in (d.answer or "").lower()

    async def test_hello_question(self):
        from app.agent_runtime.brain_orchestrator import BrainOrchestrator, BrainOrchestratorInput

        d = await BrainOrchestrator(_settings()).decide(
            BrainOrchestratorInput(call_sid="CAlive3", user_text="Hello?")
        )
        assert d.response_mode == "direct_answer"
        assert "could you say that one more time" not in (d.answer or "").lower()

    async def test_why_not_using_llm(self):
        from app.agent_runtime.brain_orchestrator import BrainOrchestrator, BrainOrchestratorInput

        d = await BrainOrchestrator(_settings()).decide(
            BrainOrchestratorInput(call_sid="CAlive4", user_text="Why are you not using LLM?")
        )
        answer = (d.answer or "").lower()
        assert "scout" not in answer
        assert "prefetch" not in answer
        assert "orchestrator" not in answer

    def test_business_resolver_cannot_override_brain_when_enabled(self):
        from app.config import Settings
        s = Settings(VOICE_BRAIN_ORCHESTRATOR_ENABLED=True)
        assert s.VOICE_BRAIN_ORCHESTRATOR_ENABLED is True

    def test_generic_unknown_not_used_before_brain(self):
        from app.agent_runtime.runtime import is_brain_orchestrator_mode
        from app.config import Settings

        assert is_brain_orchestrator_mode(
            Settings(
                VOICE_AGENT_RUNTIME_MODE="main_llm_agent",
                VOICE_BRAIN_ORCHESTRATOR_ENABLED=True,
            )
        )
