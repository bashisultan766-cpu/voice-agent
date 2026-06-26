"""v4.14.4 — Order, refund, facility tool restore tests."""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


@pytest.fixture
def settings():
    from app.config import get_settings
    return get_settings()


def _session():
    from app.state.models import SessionState
    return SessionState(
        session_id="sess4144order",
        call_sid="CA4144ORDER",
        from_number="+15551234567",
        to_number="+15559876543",
    )


class TestOrderRefundFacilityTools:
    @pytest.mark.asyncio
    async def test_order_number_starts_order_lookup(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="Order number is 1234",
            settings=settings,
        )
        assert decision["response_mode"] == "needs_tools"
        assert "order_lookup" in decision["tool_categories"]

    @pytest.mark.asyncio
    async def test_order_status_asks_for_details(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="Can you check my order status?",
            settings=settings,
        )
        assert decision["response_mode"] in ("needs_tools", "direct_answer")
        if decision["response_mode"] == "direct_answer":
            assert "order" in decision.get("direct_answer", "").lower() or decision["intent"] == "order_lookup"

    @pytest.mark.asyncio
    async def test_refund_status_lookup(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="What's my refund status for order 1234?",
            settings=settings,
        )
        assert decision["response_mode"] == "needs_tools"
        assert "refund_lookup" in decision["tool_categories"]

    @pytest.mark.asyncio
    async def test_facility_approval_worker(self, settings):
        from app.agent_runtime.runtime import EricAgentRuntime
        from app.pipeline.router import IntentResult

        runtime = EricAgentRuntime(settings=settings)
        session = _session()
        router_result = IntentResult(
            intent="facility",
            confidence=0.90,
            entities={"facility_name": "Red Rock", "raw_text": "Is Red Rock facility approved?"},
        )
        decision = {
            "intent": "facility",
            "tool_categories": ["facility_approval"],
        }

        with patch("app.workers.orchestrator._run_one", new_callable=AsyncMock) as mock_run:
            from app.workers.base import WorkerResult

            mock_run.return_value = WorkerResult(
                worker_name="facility_approval", success=True, source="cache",
            )
            await runtime._execute_main_llm_tools(
                ["facility_approval"], router_result, session, settings, decision=decision,
            )
            called = [c.args[0] for c in mock_run.call_args_list]
            assert "facility_approval" in called

    @pytest.mark.asyncio
    async def test_shipping_question(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="How much is shipping?",
            settings=settings,
        )
        assert decision["response_mode"] == "needs_tools"
        assert "shipping_lookup" in decision["tool_categories"]

    @pytest.mark.asyncio
    async def test_address_update_escalation(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="I need to update my address",
            settings=settings,
        )
        assert decision["response_mode"] == "needs_tools"
        assert "address_update" in decision["tool_categories"]

    @pytest.mark.asyncio
    async def test_order_lookup_worker_called(self, settings):
        from app.agent_runtime.runtime import EricAgentRuntime
        from app.pipeline.router import IntentResult

        runtime = EricAgentRuntime(settings=settings)
        session = _session()
        router_result = IntentResult(
            intent="order_lookup",
            confidence=0.92,
            entities={"order_number": "1234"},
        )
        decision = {"intent": "order_lookup", "tool_categories": ["order_lookup"]}

        with patch("app.workers.orchestrator._run_one", new_callable=AsyncMock) as mock_run:
            from app.workers.base import WorkerResult

            mock_run.return_value = WorkerResult(
                worker_name="order_lookup", success=True, source="cache",
            )
            await runtime._execute_main_llm_tools(
                ["order_lookup"], router_result, session, settings, decision=decision,
            )
            called = [c.args[0] for c in mock_run.call_args_list]
            assert "order_lookup" in called
