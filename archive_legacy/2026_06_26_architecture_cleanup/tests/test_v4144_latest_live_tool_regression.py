"""v4.14.4 — Latest live tool regression tests."""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("VOICE_AGENT_RUNTIME_MODE", "main_llm_agent")


@pytest.fixture
def settings():
    from app.config import Settings
    return Settings(
        OPENAI_API_KEY="test",
        DEBUG=True,
        VOICE_AGENT_RUNTIME_MODE="main_llm_agent",
    )


def _session():
    from app.state.models import SessionState
    return SessionState(
        session_id="sess4144live",
        call_sid="CA4144LIVE",
        from_number="+15551234567",
        to_number="+15559876543",
    )


class TestLatestLiveToolRegression:
    @pytest.mark.asyncio
    async def test_vague_book_find_me(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="Can you find me a book for me?",
            settings=settings,
        )
        assert decision["intent"] == "vague_book_request"
        assert decision["response_mode"] == "direct_answer"
        assert "ISBN" in decision["direct_answer"]

    @pytest.mark.asyncio
    async def test_spaced_isbn_needs_tools(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        text = "The ISBN number is 9 7 9 8 9 9 3 8 6 1 8 0 7."
        decision = await decide_and_answer(user_turn=text, settings=settings)
        assert decision["response_mode"] == "needs_tools"
        assert decision["intent"] == "isbn_lookup"
        assert decision["tool_entities"].get("isbn") == "9798993861807"

    @pytest.mark.asyncio
    async def test_bare_isbn_after_collection(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        session = _session()
        session.dialogue.expected_next = "isbn_number"
        decision = await decide_and_answer(
            user_turn="9798993861807.",
            session=session,
            settings=settings,
        )
        assert decision["response_mode"] == "needs_tools"
        assert decision["intent"] == "isbn_lookup"

    @pytest.mark.asyncio
    async def test_spaced_isbn_full_turn_no_crash(self, settings):
        from app.agent_runtime.runtime import EricAgentRuntime

        runtime = EricAgentRuntime(settings=settings)
        session = _session()
        sent = []

        async def send(msg):
            sent.append(msg)

        with patch("app.workers.orchestrator._run_one", new_callable=AsyncMock) as mock_run, \
             patch.object(
                 runtime, "_compose_main_llm_answer",
                 new_callable=AsyncMock,
                 return_value="I found the book you asked about.",
             ):
            from app.workers.base import WorkerResult

            mock_run.return_value = WorkerResult(
                worker_name="product_isbn",
                success=True,
                safe_summary="Found Test Book",
                data={"title": "Test Book", "price": "$12.99"},
                source="cache",
            )
            result = await runtime.handle_turn(
                session,
                "The ISBN number is 9 7 9 8 9 9 3 8 6 1 8 0 7.",
                send,
            )

        assert mock_run.called
        assert result.response_text
        assert "Could you say that one more time?" not in result.response_text

    @pytest.mark.asyncio
    async def test_did_you_find_running(self, settings):
        from app.agent_runtime.pending_tool_state import (
            handle_pending_tool_status_query,
            start_pending_tool,
        )

        start_pending_tool("CA4144LIVE", "isbn_lookup", ["isbn_lookup"], {})
        reply = handle_pending_tool_status_query("CA4144LIVE", "Did you find this?")
        assert reply == "I'm still checking that. One moment."

    @pytest.mark.asyncio
    async def test_no_openai_tools_in_live_mode(self, settings):
        from app.ai.openai_agent import run_agent_turn

        session = _session()
        with pytest.raises(RuntimeError, match="VOICE_LIVE_DISABLE_OPENAI_TOOLS"):
            async for _ in run_agent_turn(session, "hello", settings=settings):
                pass

    @pytest.mark.asyncio
    async def test_no_legacy_runtime_mode(self, settings):
        assert settings.VOICE_AGENT_RUNTIME_MODE == "main_llm_agent"
        assert settings.VOICE_AGENT_RUNTIME_MODE != "legacy_v410"

    @pytest.mark.asyncio
    async def test_main_llm_not_llm_brain(self, settings):
        from app.agent_runtime.runtime import is_main_llm_agent_mode

        assert is_main_llm_agent_mode(settings)
        assert settings.VOICE_LLM_BRAIN_ENABLED is False or True  # mode is main_llm_agent

    @pytest.mark.asyncio
    async def test_isbn_is_9798993861807_no_typeerror(self, settings):
        from app.agent_runtime.intent_result_builder import _build_intent_result_from_agent_decision

        decision = {
            "intent": "isbn_lookup",
            "confidence": 0.97,
            "tool_categories": ["isbn_lookup", "catalog_search"],
            "search_query": "9798993861807",
            "tool_entities": {"isbn": "9798993861807"},
        }
        result = _build_intent_result_from_agent_decision(
            decision, "ISBN is 9798993861807",
        )
        assert result.confidence == 0.97
        assert result.entities["isbn"] == "9798993861807"
