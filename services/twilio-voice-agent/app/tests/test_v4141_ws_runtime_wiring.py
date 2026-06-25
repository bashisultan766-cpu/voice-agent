"""
Live WebSocket runtime wiring (updated for v4.18 single runtime).

The legacy multi-mode wiring (main_llm_agent -> EricAgentRuntime,
legacy_v410 -> pipeline engine) was removed. Every assembled turn now routes to
the single LLM-first tool runtime; the legacy pipeline engine and Eric runtime
are never invoked from the live path, and the /health endpoint reports the
active handler honestly (always llm_tool_runtime), even when a legacy mode value
is still configured.
"""
from __future__ import annotations

import logging
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


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
        session_id="s4141",
        call_sid="CA41410001",
        from_number="+15550004141",
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
class TestWSRuntimeWiring:
    async def test_routes_to_llm_tool_runtime(self, caplog):
        settings = _settings(VOICE_AGENT_RUNTIME_MODE="llm_tool_runtime")
        fake_runtime = MagicMock()
        fake_runtime.handle_turn = AsyncMock(return_value=MagicMock(response_text="My name is Eric."))

        with patch(
            "app.agent_runtime.llm_tool_runtime.get_llm_tool_runtime",
            return_value=fake_runtime,
        ):
            await _run_dispatch(settings, "What is your name?", caplog=caplog)

        fake_runtime.handle_turn.assert_called_once()
        assert "voice_turn_handler" in caplog.text
        assert "handler=llm_tool_runtime" in caplog.text

    async def test_legacy_engine_never_called(self):
        settings = _settings(VOICE_AGENT_RUNTIME_MODE="legacy_v410")
        mock_engine = MagicMock()
        mock_engine.handle_turn = AsyncMock()
        mock_eric = MagicMock()
        mock_eric.handle_turn = AsyncMock()
        fake_runtime = MagicMock()
        fake_runtime.handle_turn = AsyncMock(return_value=MagicMock(response_text="ok"))

        with patch("app.ws.conversation_relay.get_engine", return_value=mock_engine), patch(
            "app.ws.conversation_relay.get_eric_runtime", return_value=mock_eric
        ), patch(
            "app.agent_runtime.llm_tool_runtime.get_llm_tool_runtime",
            return_value=fake_runtime,
        ):
            await _run_dispatch(settings, "What is your name?")

        mock_engine.handle_turn.assert_not_called()
        mock_eric.handle_turn.assert_not_called()
        fake_runtime.handle_turn.assert_called_once()

    async def test_unknown_mode_still_routes_to_new_runtime(self, caplog):
        settings = _settings(VOICE_AGENT_RUNTIME_MODE="unknown_mode")
        mock_engine = MagicMock()
        mock_engine.handle_turn = AsyncMock()
        fake_runtime = MagicMock()
        fake_runtime.handle_turn = AsyncMock(return_value=MagicMock(response_text="ok"))
        caplog.set_level(logging.INFO)

        with patch("app.ws.conversation_relay.get_engine", return_value=mock_engine), patch(
            "app.agent_runtime.llm_tool_runtime.get_llm_tool_runtime",
            return_value=fake_runtime,
        ):
            await _run_dispatch(settings, "Hello", caplog=caplog)

        mock_engine.handle_turn.assert_not_called()
        fake_runtime.handle_turn.assert_called_once()
        assert "legacy_runtime_mode_ignored" in caplog.text


class TestHealthLiveTurnHandler:
    def test_health_live_turn_handler_is_always_new_runtime(self, monkeypatch):
        # Even with a legacy mode configured, the live handler is the new runtime.
        monkeypatch.setenv("VOICE_AGENT_RUNTIME_MODE", "main_llm_agent")
        from app.config import get_settings

        get_settings.cache_clear()
        from fastapi.testclient import TestClient
        from app.main import create_app

        client = TestClient(create_app())
        resp = client.get("/health")
        data = resp.json()
        assert data["runtime_mode"] == "main_llm_agent"
        assert data["live_turn_handler"] == "llm_tool_runtime"
        get_settings.cache_clear()
