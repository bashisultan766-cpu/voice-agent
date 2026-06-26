"""v4.14.4 — Parallel tool fanout tests."""
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
        session_id="sess4144fanout",
        call_sid="CA4144FANOUT",
        from_number="+15551234567",
        to_number="+15559876543",
    )


class TestParallelToolFanout:
    @pytest.mark.asyncio
    async def test_isbn_fanout_runs_workers(self, settings):
        from app.agent_runtime.runtime import EricAgentRuntime
        from app.pipeline.router import IntentResult
        from app.workers.orchestrator import _INTENT_WORKERS

        runtime = EricAgentRuntime(settings=settings)
        session = _session()
        router_result = IntentResult(
            intent="isbn_lookup",
            confidence=0.97,
            entities={"isbn": "9798993861807", "raw_text": "ISBN is 9798993861807"},
        )
        decision = {
            "intent": "isbn_lookup",
            "tool_categories": ["isbn_lookup", "catalog_search"],
        }

        with patch("app.workers.orchestrator._run_one", new_callable=AsyncMock) as mock_run:
            from app.workers.base import WorkerResult

            mock_run.return_value = WorkerResult(
                worker_name="product_isbn", success=True, source="cache",
            )
            bundle = await runtime._execute_main_llm_tools(
                ["isbn_lookup", "catalog_search"],
                router_result, session, settings, decision=decision,
            )

        assert mock_run.call_count >= len(_INTENT_WORKERS["isbn_search"])
        assert bundle.total_ms >= 0

    @pytest.mark.asyncio
    async def test_catalog_search_for_title(self, settings):
        from app.agent_runtime.runtime import EricAgentRuntime
        from app.pipeline.router import IntentResult

        runtime = EricAgentRuntime(settings=settings)
        session = _session()
        router_result = IntentResult(
            intent="book_title_search",
            confidence=0.94,
            entities={"product_phrase": "Game of Thrones"},
        )
        decision = {
            "intent": "book_title_search",
            "tool_categories": ["catalog_search"],
        }

        with patch("app.workers.orchestrator._run_one", new_callable=AsyncMock) as mock_run:
            from app.workers.base import WorkerResult

            mock_run.return_value = WorkerResult(
                worker_name="product_search", success=True, source="cache",
            )
            await runtime._execute_main_llm_tools(
                ["catalog_search"], router_result, session, settings, decision=decision,
            )

        called_workers = [c.args[0] for c in mock_run.call_args_list]
        assert "product_search" in called_workers

    @pytest.mark.asyncio
    async def test_worker_failure_does_not_crash(self, settings):
        from app.agent_runtime.runtime import EricAgentRuntime
        from app.pipeline.router import IntentResult

        runtime = EricAgentRuntime(settings=settings)
        session = _session()
        router_result = IntentResult(
            intent="isbn_lookup",
            confidence=0.97,
            entities={"isbn": "9798993861807"},
        )
        decision = {"intent": "isbn_lookup", "tool_categories": ["isbn_lookup"]}

        with patch("app.workers.orchestrator._run_one", new_callable=AsyncMock) as mock_run:
            mock_run.side_effect = RuntimeError("shopify down")
            bundle = await runtime._execute_main_llm_tools(
                ["isbn_lookup"], router_result, session, settings, decision=decision,
            )

        assert bundle.results
        assert all(not r.success for r in bundle.results.values())

    @pytest.mark.asyncio
    async def test_cricket_subject_catalog_search(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="Do you have books about cricket?",
            settings=settings,
        )
        assert decision["response_mode"] == "needs_tools"
        assert "catalog_search" in decision["tool_categories"]
