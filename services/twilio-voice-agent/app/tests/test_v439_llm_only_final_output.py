"""v4.39 — LLM-only final output: strong model, no short-circuit speech."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent_runtime.llm_tool_runtime import (
    LLMToolRuntime,
    llm_only_final_output_enabled,
)
from app.config import Settings
from app.state.models import SessionState


def _settings(**kwargs) -> Settings:
    base = dict(
        OPENAI_API_KEY="sk-test",
        OPENAI_MODEL="gpt-4o",
        VOICE_LLM_ONLY_FINAL_OUTPUT=True,
        VOICE_ENFORCE_DETERMINISTIC_TOOL_RESPONSE=False,
    )
    base.update(kwargs)
    return Settings(**base)


def _session() -> SessionState:
    return SessionState(
        session_id="v439",
        call_sid="CA_V439001",
        from_number="+1",
        to_number="+2",
    )


class TestLlmOnlyConfig:
    def test_default_model_is_gpt4o(self):
        s = Settings()
        assert s.OPENAI_MODEL == "gpt-4o"
        assert s.VOICE_LLM_ONLY_FINAL_OUTPUT is True

    def test_llm_only_helper(self):
        assert llm_only_final_output_enabled(_settings()) is True
        assert llm_only_final_output_enabled(_settings(VOICE_LLM_ONLY_FINAL_OUTPUT=False)) is False


class TestLlmOnlyRuntimeSkipsShortCircuits:
    @pytest.mark.asyncio
    async def test_greeting_routes_to_openai_when_llm_only(self):
        runtime = LLMToolRuntime(settings=_settings())
        session = _session()
        send = AsyncMock()

        mock_resp = MagicMock()
        mock_resp.choices = [MagicMock()]
        mock_resp.choices[0].message.content = "Hey! I'm doing well. How can I help?"
        mock_resp.choices[0].message.tool_calls = None

        with patch.object(runtime, "_run_tool_loop", new_callable=AsyncMock) as mock_loop:
            mock_loop.return_value = ("Hey! I'm doing well. How can I help?", [], [])
            result = await runtime.handle_turn(session, "Hello. How are you?", send)

        assert "How can I help" in result.response_text
        mock_loop.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_legacy_short_circuit_when_disabled(self):
        runtime = LLMToolRuntime(settings=_settings(VOICE_LLM_ONLY_FINAL_OUTPUT=False))
        session = _session()
        send = AsyncMock()

        with patch("app.agent_runtime.fast_greeting.fast_greeting_reply", return_value="Hi there!"):
            result = await runtime.handle_turn(session, "Hello", send)

        assert "Hi there" in result.response_text
        send.assert_awaited()
