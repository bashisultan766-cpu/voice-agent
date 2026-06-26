"""v4.14.3 — MainLLMAgent commerce brain guarantee integration tests."""
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


class TestMainLlmCommerceGuarantees:
    @pytest.mark.asyncio
    async def test_job_question_no_llm(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        with patch("app.agent_runtime.main_llm_agent.AsyncOpenAI") as mock_client:
            decision = await decide_and_answer(
                user_turn="So my what is your job?",
                settings=settings,
            )
            mock_client.assert_not_called()

        assert decision["intent"] == "job_question"
        assert "My job is to help you as the SureShot Books assistant" in decision["direct_answer"]
        assert decision["tool_categories"] == []

    @pytest.mark.asyncio
    async def test_job_question_exact_answer(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="What is your job?",
            settings=settings,
        )
        assert decision["intent"] == "job_question"
        assert "My job is to help you as the SureShot Books assistant" in decision["direct_answer"]
        assert "I'm with SureShot Books" not in decision["direct_answer"].split(".")[0]
        assert decision["tool_categories"] == []

    @pytest.mark.asyncio
    async def test_vague_book_no_tools(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="So I need a a book",
            settings=settings,
        )
        assert decision["intent"] == "vague_book_request"
        assert decision["response_mode"] == "direct_answer"
        assert "ISBN" in decision["direct_answer"]
        assert decision["tool_categories"] == []

    @pytest.mark.asyncio
    async def test_isbn_collection_no_tools(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="Can I give you the ISBN number?",
            settings=settings,
        )
        assert decision["intent"] == "isbn_collection_start"
        assert decision["direct_answer"] == "Yes, please say the ISBN number."
        assert decision["tool_categories"] == []

    @pytest.mark.asyncio
    async def test_off_domain_no_generic_repeat(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="Can you give me cricket match information?",
            settings=settings,
        )
        assert decision["intent"] == "off_domain"
        assert "didn't understand" not in decision["direct_answer"].lower()
        assert decision["tool_categories"] == []

    @pytest.mark.asyncio
    async def test_llm_unknown_recovered_for_title_start(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        mock_resp = AsyncMock()
        mock_resp.choices = [
            AsyncMock(
                message=AsyncMock(
                    content='{"response_mode":"direct_answer","intent":"unknown","confidence":0.0,'
                    '"direct_answer":"I\'m sorry, I didn\'t understand. Could you repeat that?",'
                    '"tool_categories":[]}'
                )
            )
        ]
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_resp)

        with patch("app.agent_runtime.main_llm_agent.AsyncOpenAI", return_value=mock_client):
            decision = await decide_and_answer(
                user_turn="The title name is",
                settings=settings,
            )

        assert decision["intent"] == "title_collection_start"
        assert "full title" in decision["direct_answer"].lower()
        assert "didn't understand" not in decision["direct_answer"].lower()

    @pytest.mark.asyncio
    async def test_okay_hold_without_expected_next(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="Okay.",
            settings=settings,
        )
        assert decision["response_mode"] == "hold"
        assert decision.get("direct_answer", "") == ""
