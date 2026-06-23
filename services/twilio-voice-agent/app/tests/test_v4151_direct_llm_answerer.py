"""v4.15.1 — Direct LLM answerer tests."""
from __future__ import annotations

import asyncio
import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


class TestDirectLLMAnswerer:
    @pytest.mark.asyncio
    async def test_timeout_greeting_fallback(self):
        from app.agent_runtime.direct_llm_answerer import answer_directly

        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(side_effect=asyncio.TimeoutError())

        with patch("app.agent_runtime.direct_llm_answerer.AsyncOpenAI", return_value=mock_client):
            result = await answer_directly("How are you?", intent="small_talk")

        assert "let me check" not in result.answer.lower()
        assert "help" in result.answer.lower()
        assert result.source == "direct_llm_answerer"

    @pytest.mark.asyncio
    async def test_timeout_memory_fallback(self):
        from app.agent_runtime.direct_llm_answerer import answer_directly

        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(side_effect=asyncio.TimeoutError())

        with patch("app.agent_runtime.direct_llm_answerer.AsyncOpenAI", return_value=mock_client):
            result = await answer_directly(
                "I spoke with you last year, remember?",
                intent="memory_question",
            )

        assert "let me check" not in result.answer.lower()
        assert "help" in result.answer.lower() or "details" in result.answer.lower()

    @pytest.mark.asyncio
    async def test_repairs_fake_checking_from_llm(self):
        from app.agent_runtime.direct_llm_answerer import answer_directly

        mock_resp = AsyncMock()
        mock_resp.choices = [AsyncMock(message=AsyncMock(content="Let me check on that."))]
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_resp)

        with patch("app.agent_runtime.direct_llm_answerer.AsyncOpenAI", return_value=mock_client):
            result = await answer_directly("How are you?", intent="small_talk")

        assert "let me check" not in result.answer.lower()
