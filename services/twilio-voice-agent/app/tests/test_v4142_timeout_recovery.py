"""v4.14.2 — MainLLMAgent timeout recovery with brand alias context."""
from __future__ import annotations

import asyncio
import logging
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


@pytest.fixture
def settings():
    from app.config import get_settings
    return get_settings()


class TestTimeoutRecovery:
    @pytest.mark.asyncio
    async def test_timeout_recovers_brand_alias_query(self, settings, caplog):
        caplog.set_level(logging.INFO)
        from app.agent_runtime.main_llm_agent import decide_and_answer

        mock_instance = MagicMock()
        mock_instance.chat.completions.create = AsyncMock(
            side_effect=asyncio.TimeoutError()
        )

        with patch(
            "app.agent_runtime.main_llm_agent.AsyncOpenAI",
            return_value=mock_instance,
        ), patch(
            "app.agent_runtime.main_llm_agent._brand_alias_direct_answer",
            return_value=None,
        ):
            decision = await decide_and_answer(
                user_turn=(
                    "I'm asking, are you sure, Shard Book or are you show short book "
                    "assistant who sell the books?"
                ),
                settings=settings,
            )

        assert decision["response_mode"] == "direct_answer"
        answer_lower = decision["direct_answer"].lower()
        assert (
            "sureshot books assistant" in answer_lower
            or "bookstore service" in answer_lower
        )
        assert "didn't catch that" not in answer_lower
        assert (
            "main_llm_timeout_recovered" in caplog.text
            or "business_intent_resolved" in caplog.text
        )

    @pytest.mark.asyncio
    async def test_timeout_hear_me_check(self, settings, caplog):
        caplog.set_level(logging.INFO)
        from app.agent_runtime.main_llm_agent import decide_and_answer

        mock_instance = MagicMock()
        mock_instance.chat.completions.create = AsyncMock(
            side_effect=asyncio.TimeoutError()
        )

        with patch(
            "app.agent_runtime.main_llm_agent.AsyncOpenAI",
            return_value=mock_instance,
        ):
            decision = await decide_and_answer(
                user_turn="Can you hear me?",
                settings=settings,
            )

        assert "Yes, I can hear you" in decision["direct_answer"]
        assert decision["intent"] == "presence_check"
        assert decision["response_mode"] == "direct_answer"

    @pytest.mark.asyncio
    async def test_timeout_unhandled_logs(self, settings, caplog):
        caplog.set_level(logging.INFO)
        from app.agent_runtime.main_llm_agent import decide_and_answer

        mock_instance = MagicMock()
        mock_instance.chat.completions.create = AsyncMock(
            side_effect=asyncio.TimeoutError()
        )

        with patch(
            "app.agent_runtime.main_llm_agent.AsyncOpenAI",
            return_value=mock_instance,
        ):
            decision = await decide_and_answer(
                user_turn="Hmm uh maybe something random xyz",
                settings=settings,
            )

        assert "didn't catch that" in decision["direct_answer"].lower()
        assert "main_llm_timeout_unhandled" in caplog.text


class TestMainLlmTimeoutConfig:
    def test_default_timeout_is_6000ms(self, monkeypatch):
        monkeypatch.delenv("VOICE_MAIN_LLM_TIMEOUT_MS", raising=False)
        from app.config import Settings
        s = Settings()
        assert s.VOICE_MAIN_LLM_TIMEOUT_MS == 6000
