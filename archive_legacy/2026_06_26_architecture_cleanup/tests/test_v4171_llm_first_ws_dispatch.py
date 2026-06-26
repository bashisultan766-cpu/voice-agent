"""
ConversationRelay dispatch contract (updated for v4.18 single runtime).

The legacy multi-mode dispatch matrix was removed. There is now exactly one live
runtime — LLM_TOOL_RUNTIME — and every assembled turn routes to it regardless of
the configured (legacy) VOICE_AGENT_RUNTIME_MODE, never leaving the caller in
silence and never touching the legacy pipeline engine.
"""
from __future__ import annotations

import logging
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")


def _settings(**overrides):
    from app.config import Settings

    defaults = dict(
        OPENAI_API_KEY="test",
        DEBUG=True,
        VOICE_AGENT_RUNTIME_MODE="llm_tool_runtime",
        VOICE_CR_TEXT_INTERRUPTIBLE=True,
        VOICE_CR_TEXT_PREEMPTIBLE=False,
        VOICE_LANGUAGE="en-US",
    )
    defaults.update(overrides)
    return Settings(**defaults)


def _session():
    from app.state.models import SessionState

    return SessionState(
        session_id="s4171",
        call_sid="CA41710001",
        from_number="+15550004171",
        to_number="+15559998888",
    )


async def _run_dispatch(settings, user_text: str, *, caplog=None):
    from app.ws.conversation_relay import dispatch_assembled_turn

    captured: list[dict] = []

    async def send(msg: dict):
        captured.append(msg)

    session = _session()
    if caplog is not None:
        caplog.set_level(logging.INFO)

    await dispatch_assembled_turn(settings, session, user_text, send, caller_context=None)
    return captured


@pytest.mark.asyncio
class TestSingleRuntimeDispatch:
    async def test_turn_routes_to_llm_tool_runtime_not_legacy_engine(self, caplog):
        settings = _settings(VOICE_AGENT_RUNTIME_MODE="llm_tool_runtime")
        mock_engine = MagicMock()
        mock_engine.handle_turn = AsyncMock()
        fake_runtime = MagicMock()
        fake_runtime.handle_turn = AsyncMock(return_value=MagicMock(response_text="Hi there."))

        with patch("app.ws.conversation_relay.get_engine", return_value=mock_engine), patch(
            "app.agent_runtime.llm_tool_runtime.get_llm_tool_runtime",
            return_value=fake_runtime,
        ):
            await _run_dispatch(settings, "Hello. How are you?", caplog=caplog)

        mock_engine.handle_turn.assert_not_called()
        fake_runtime.handle_turn.assert_called_once()
        assert "voice_turn_handler" in caplog.text
        assert "handler=llm_tool_runtime" in caplog.text

    async def test_resolve_handler_is_llm_tool_runtime(self):
        from app.agent_runtime.runtime import resolve_live_turn_handler

        settings = _settings(VOICE_AGENT_RUNTIME_MODE="llm_tool_runtime")
        assert resolve_live_turn_handler(settings) == "llm_tool_runtime"

    async def test_legacy_mode_is_ignored_and_still_routes_to_new_runtime(self, caplog):
        """A legacy mode value must be ignored, not run the old runtime."""
        settings = _settings(VOICE_AGENT_RUNTIME_MODE="main_llm_agent")
        fake_runtime = MagicMock()
        fake_runtime.handle_turn = AsyncMock(return_value=MagicMock(response_text="ok"))
        caplog.set_level(logging.INFO)

        with patch(
            "app.agent_runtime.llm_tool_runtime.get_llm_tool_runtime",
            return_value=fake_runtime,
        ):
            await _run_dispatch(settings, "Hello", caplog=caplog)

        fake_runtime.handle_turn.assert_called_once()
        assert "legacy_runtime_mode_ignored" in caplog.text
