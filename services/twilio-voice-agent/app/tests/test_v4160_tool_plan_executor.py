"""v4.16.0 — ToolPlanExecutor tests."""
from __future__ import annotations

import os
from unittest.mock import AsyncMock

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


def _settings(**overrides):
    from app.config import Settings
    defaults = dict(OPENAI_API_KEY="test", DEBUG=True)
    defaults.update(overrides)
    return Settings(**defaults)


def _session():
    from app.state.models import SessionState
    return SessionState(
        session_id="s4160",
        call_sid="CA4160TOOL",
        from_number="+15550004160",
        to_number="+15559998888",
    )


@pytest.mark.asyncio
class TestToolPlanExecutor:
    async def test_requires_brain_approval(self):
        from app.agent_runtime.brain_orchestrator import BrainDecision, ToolPlan
        from app.agent_runtime.brain_prefetch_arbitrator import AcceptedPrefetchContext
        from app.agent_runtime.tool_plan_executor import ToolPlanExecutor

        decision = BrainDecision(
            response_mode="needs_tools",
            intent="catalog_product_search",
            confidence=0.9,
            answer=None,
            tool_plan=ToolPlan(categories=["catalog_search"], intent="catalog_product_search", approved_by_brain=False),
        )
        executor = ToolPlanExecutor()
        result = await executor.execute(
            decision,
            AcceptedPrefetchContext(),
            session=_session(),
            settings=_settings(),
            user_text="Find books",
            runtime_executor=AsyncMock(),
        )
        assert result.worker_bundle is None

    async def test_executes_after_brain_approval(self):
        from app.agent_runtime.brain_orchestrator import BrainDecision, ToolPlan
        from app.agent_runtime.brain_prefetch_arbitrator import AcceptedPrefetchContext
        from app.agent_runtime.tool_plan_executor import ToolPlanExecutor
        from app.workers.base import WorkerBundle

        mock_bundle = WorkerBundle()
        mock_exec = AsyncMock(return_value=mock_bundle)
        decision = BrainDecision(
            response_mode="needs_tools",
            intent="catalog_product_search",
            confidence=0.9,
            answer=None,
            tool_plan=ToolPlan(categories=["catalog_search"], intent="catalog_product_search", approved_by_brain=True),
        )
        result = await ToolPlanExecutor().execute(
            decision,
            AcceptedPrefetchContext(),
            session=_session(),
            settings=_settings(),
            user_text="Find cricket books",
            runtime_executor=mock_exec,
        )
        assert mock_exec.called
        assert result.worker_bundle is mock_bundle

    async def test_payment_blocked_without_confirmed_email(self):
        from app.agent_runtime.brain_orchestrator import BrainDecision, ToolPlan
        from app.agent_runtime.brain_prefetch_arbitrator import AcceptedPrefetchContext
        from app.agent_runtime.tool_plan_executor import ToolPlanExecutor

        decision = BrainDecision(
            response_mode="needs_tools",
            intent="payment",
            confidence=0.9,
            answer=None,
            tool_plan=ToolPlan(categories=["payment_flow"], intent="payment", mutating=True, approved_by_brain=True),
        )
        with pytest.raises(ValueError):
            await ToolPlanExecutor().execute(
                decision,
                AcceptedPrefetchContext(),
                session=_session(),
                settings=_settings(),
                user_text="Send payment link",
                runtime_executor=AsyncMock(),
            )
