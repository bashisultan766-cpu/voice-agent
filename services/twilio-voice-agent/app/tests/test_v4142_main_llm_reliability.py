"""v4.14.2 — MainLLMAgent brand alias fast path and business identity reliability."""
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


class TestBrandAliasFastPath:
    @pytest.mark.asyncio
    async def test_shorkshire_books_company_question(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        with patch("app.agent_runtime.main_llm_agent.AsyncOpenAI") as mock_client:
            decision = await decide_and_answer(
                user_turn="What is your Shorkshire books?",
                settings=settings,
            )
            mock_client.assert_not_called()

        assert decision["intent"] == "company_question"
        assert decision["response_mode"] == "direct_answer"
        assert "SureShot Books is a bookstore service" in decision["direct_answer"]
        assert decision["tool_categories"] == []
        assert decision["confidence"] >= 0.90

    @pytest.mark.asyncio
    async def test_show_short_book_assistant_identity(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        with patch("app.agent_runtime.main_llm_agent.AsyncOpenAI") as mock_client:
            decision = await decide_and_answer(
                user_turn="Are you show short book assistant?",
                settings=settings,
            )
            mock_client.assert_not_called()

        assert decision["intent"] == "assistant_identity"
        assert decision["response_mode"] == "direct_answer"
        assert "Yes, I'm Eric, the SureShot Books assistant" in decision["direct_answer"]
        assert decision["tool_categories"] == []

    @pytest.mark.asyncio
    async def test_brochure_book_assistant_identity(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        with patch("app.agent_runtime.main_llm_agent.AsyncOpenAI") as mock_client:
            decision = await decide_and_answer(
                user_turn="I'm saying you are a brochure book assistant.",
                settings=settings,
            )
            mock_client.assert_not_called()

        assert decision["intent"] == "assistant_identity"
        assert "SureShot Books assistant" in decision["direct_answer"]
        assert decision["tool_categories"] == []

    @pytest.mark.asyncio
    async def test_short_short_books_company_question(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        with patch("app.agent_runtime.main_llm_agent.AsyncOpenAI") as mock_client:
            decision = await decide_and_answer(
                user_turn="Or you are short short books?",
                settings=settings,
            )
            mock_client.assert_not_called()

        assert decision["intent"] == "company_question"
        assert "SureShot Books" in decision["direct_answer"]
        assert decision["tool_categories"] == []

    @pytest.mark.asyncio
    async def test_company_purpose(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        with patch("app.agent_runtime.main_llm_agent.AsyncOpenAI") as mock_client:
            decision = await decide_and_answer(
                user_turn="What is the purpose of SureShot Books?",
                settings=settings,
            )
            mock_client.assert_not_called()

        assert decision["response_mode"] == "direct_answer"
        assert "help customers find and order books" in decision["direct_answer"]
        assert decision["tool_categories"] == []

    @pytest.mark.asyncio
    async def test_what_do_you_sell(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        with patch("app.agent_runtime.main_llm_agent.AsyncOpenAI") as mock_client:
            decision = await decide_and_answer(
                user_turn="What do you sell?",
                settings=settings,
            )
            mock_client.assert_not_called()

        assert decision["response_mode"] == "direct_answer"
        assert "book" in decision["direct_answer"].lower()
        assert decision["tool_categories"] == []


class TestRegressions:
    @pytest.mark.asyncio
    async def test_what_is_your_name(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="What is your name?",
            settings=settings,
        )
        assert decision["intent"] == "identity"
        assert decision["direct_answer"] == "My name is Eric. I'm with SureShot Books."

    @pytest.mark.asyncio
    async def test_i_need_a_book(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="I need a book",
            settings=settings,
        )
        assert decision["intent"] in ("vague_book_request", "book_search")
        assert decision["response_mode"] == "direct_answer"
        assert "ISBN" in decision["direct_answer"]
        assert "title" in decision["direct_answer"].lower()
        assert decision["tool_categories"] == []

    @pytest.mark.asyncio
    async def test_football_books_needs_tools(self, settings):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="Do you have books about football?",
            settings=settings,
        )
        assert decision["response_mode"] == "needs_tools"
        assert "catalog_search" in decision["tool_categories"]


class TestNoGenericRepeatForBrandQueries:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "text",
        [
            "What is your Shorkshire books?",
            "Are you show short book assistant?",
            "I'm saying you are a brochure book assistant.",
            "Or you are short short books?",
            "What is the purpose of SureShot Books?",
            "What do you sell?",
        ],
    )
    async def test_no_i_didnt_catch_that(self, settings, text):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        with patch("app.agent_runtime.main_llm_agent.AsyncOpenAI") as mock_client:
            decision = await decide_and_answer(user_turn=text, settings=settings)
            mock_client.assert_not_called()

        assert "didn't catch that" not in decision["direct_answer"].lower()
        assert "didn't understand" not in decision["direct_answer"].lower()
