"""v4.14.3 — Tool routing and entity population for business intents."""
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


class TestToolDecisionRouting:
    @pytest.mark.asyncio
    async def test_isbn_needs_tools(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="ISBN is 9780441172719",
            settings=settings,
        )
        assert decision["response_mode"] == "needs_tools"
        assert decision["intent"] == "isbn_lookup"
        assert "isbn_lookup" in decision["tool_categories"]

    @pytest.mark.asyncio
    async def test_title_search_needs_catalog(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="The title is Game of Thrones",
            settings=settings,
        )
        assert decision["response_mode"] == "needs_tools"
        assert decision["intent"] == "book_title_search"
        assert decision["tool_categories"] == ["catalog_search"]
        assert decision.get("search_query") == "Game of Thrones"

    @pytest.mark.asyncio
    async def test_cricket_books_catalog_search(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="Do you have books about cricket?",
            settings=settings,
        )
        assert decision["response_mode"] == "needs_tools"
        assert "catalog_search" in decision["tool_categories"]


class TestRuntimeToolFanout:
    @pytest.mark.asyncio
    async def test_execute_main_llm_tools_maps_isbn_workers(self, settings):
        from app.agent_runtime.runtime import EricAgentRuntime
        from app.pipeline.router import IntentResult
        from app.workers.orchestrator import _INTENT_WORKERS

        runtime = EricAgentRuntime(settings=settings)
        session = _session()
        router_result = IntentResult(
            intent="isbn_lookup",
            confidence=0.95,
            entities={"isbn": "9780441172719", "raw_text": "ISBN is 9780441172719"},
        )

        with patch("app.workers.orchestrator._run_one", new_callable=AsyncMock) as mock_run:
            from app.workers.base import WorkerResult

            mock_run.return_value = WorkerResult(
                worker_name="product_isbn",
                success=True,
                source="cache",
            )
            bundle = await runtime._execute_main_llm_tools(
                ["isbn_lookup"],
                router_result,
                session,
                settings,
                decision_intent="isbn_lookup",
            )

        assert bundle.workers_ran == _INTENT_WORKERS["isbn_search"]
        assert mock_run.call_count == len(_INTENT_WORKERS["isbn_search"])

    @pytest.mark.asyncio
    async def test_catalog_search_uses_product_search_workers(self, settings):
        from app.agent_runtime.runtime import EricAgentRuntime
        from app.pipeline.router import IntentResult
        from app.workers.orchestrator import _INTENT_WORKERS

        runtime = EricAgentRuntime(settings=settings)
        session = _session()
        router_result = IntentResult(
            intent="book_search",
            confidence=0.92,
            entities={"product_phrase": "cricket"},
        )

        with patch("app.workers.orchestrator._run_one", new_callable=AsyncMock) as mock_run:
            from app.workers.base import WorkerResult

            mock_run.return_value = WorkerResult(
                worker_name="product_search",
                success=True,
                source="cache",
            )
            await runtime._execute_main_llm_tools(
                ["catalog_search"],
                router_result,
                session,
                settings,
                decision_intent="book_search",
            )

        expected = _INTENT_WORKERS["product_search"]
        assert mock_run.call_count == len(expected)


def _session():
    from app.state.models import SessionState

    return SessionState(
        session_id="sess4143tool",
        call_sid="CA4143TOOL",
        from_number="+15551234567",
        to_number="+15559876543",
    )
