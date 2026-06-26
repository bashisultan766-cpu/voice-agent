"""v4.16.0 — BrainOrchestrator unit tests."""
from __future__ import annotations

import os
import time

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
class TestBrainOrchestrator:
    async def test_greeting_brother_direct_answer(self):
        from app.agent_runtime.brain_orchestrator import BrainOrchestrator, BrainOrchestratorInput

        brain = BrainOrchestrator(_settings())
        decision = await brain.decide(
            BrainOrchestratorInput(call_sid="CA4160", user_text="Hello. How are you, brother?")
        )
        assert decision.response_mode == "direct_answer"
        assert decision.intent in ("small_talk", "presence_check")
        assert "help" in (decision.answer or "").lower()
        assert decision.tool_plan is None

    async def test_identity_confirmation_no_hold(self):
        from app.agent_runtime.brain_orchestrator import BrainOrchestrator, BrainOrchestratorInput

        brain = BrainOrchestrator(_settings())
        decision = await brain.decide(
            BrainOrchestratorInput(call_sid="CA4160", user_text="Your name is Eric. Yes or no?")
        )
        assert decision.response_mode == "direct_answer"
        assert decision.response_mode != "hold"
        assert "eric" in (decision.answer or "").lower()

    async def test_hello_presence_direct(self):
        from app.agent_runtime.brain_orchestrator import BrainOrchestrator, BrainOrchestratorInput

        brain = BrainOrchestrator(_settings())
        decision = await brain.decide(BrainOrchestratorInput(call_sid="CA4160", user_text="Hello?"))
        assert decision.response_mode == "direct_answer"
        assert "here" in (decision.answer or "").lower()

    async def test_meta_complaint_no_architecture_leak(self):
        from app.agent_runtime.brain_orchestrator import BrainOrchestrator, BrainOrchestratorInput

        brain = BrainOrchestrator(_settings())
        decision = await brain.decide(
            BrainOrchestratorInput(call_sid="CA4160", user_text="Why are you not using LLM?")
        )
        assert decision.response_mode == "direct_answer"
        answer = (decision.answer or "").lower()
        assert "openai" not in answer
        assert "tool" not in answer
        assert "prompt" not in answer

    async def test_tool_plan_only_from_brain(self):
        from app.agent_runtime.brain_orchestrator import BrainOrchestrator, BrainOrchestratorInput, ToolPlan

        brain = BrainOrchestrator(_settings())
        decision = await brain.decide(
            BrainOrchestratorInput(call_sid="CA4160", user_text="Do you have cricket books?")
        )
        assert decision.response_mode == "needs_tools"
        assert decision.tool_plan is not None
        assert decision.tool_plan.approved_by_brain is True
        assert "catalog_search" in decision.tool_plan.categories

    async def test_payment_no_cart_clarify(self):
        from app.agent_runtime.brain_orchestrator import BrainOrchestrator, BrainOrchestratorInput

        brain = BrainOrchestrator(_settings())
        decision = await brain.decide(
            BrainOrchestratorInput(call_sid="CA4160", user_text="Send payment link.", cart_summary="")
        )
        assert decision.response_mode == "clarify"
        assert "item" in (decision.answer or "").lower()

    async def test_greeting_fast_path_under_threshold(self):
        from app.agent_runtime.brain_orchestrator import BrainOrchestrator, BrainOrchestratorInput

        brain = BrainOrchestrator(_settings())
        t0 = time.monotonic()
        await brain.decide(BrainOrchestratorInput(call_sid="CA4160", user_text="Hello?"))
        assert (time.monotonic() - t0) * 1000 < 500

    def test_brain_decision_to_legacy_dict(self):
        from app.agent_runtime.brain_orchestrator import BrainDecision, ToolPlan, brain_decision_to_legacy_dict

        legacy = brain_decision_to_legacy_dict(
            BrainDecision(
                response_mode="needs_tools",
                intent="isbn_lookup",
                confidence=0.9,
                answer=None,
                tool_plan=ToolPlan(categories=["isbn_lookup"], intent="isbn_lookup", entities={"isbn": "9780441172719"}),
            )
        )
        assert legacy["brain_approved"] is True
        assert legacy["tool_categories"] == ["isbn_lookup"]
