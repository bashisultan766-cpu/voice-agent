"""v4.14.1 — Live WebSocket runtime wiring integration tests."""
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
        VOICE_AGENT_RUNTIME_MODE="main_llm_agent",
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
    from app.agent_runtime import runtime as runtime_module
    from app.ws.conversation_relay import dispatch_assembled_turn
    from app.ws.conversation_relay_sender import ConversationRelayOutbound, ConversationRelayStats

    runtime_module._runtime = None

    captured: list[dict] = []
    stats = ConversationRelayStats()

    async def capture(msg: dict):
        captured.append(msg)

    outbound = ConversationRelayOutbound(capture, settings, "CA41410001", stats)
    outbound.set_turn(1)

    async def send(msg: dict):
        await outbound.engine_send(msg)

    session = _session()
    if caplog is not None:
        caplog.set_level(logging.INFO)

    await dispatch_assembled_turn(
        settings,
        session,
        user_text,
        send,
        caller_context=None,
    )
    await outbound.flush()
    return captured, stats


@pytest.mark.asyncio
class TestWSRuntimeWiring:
    async def test_main_llm_agent_uses_eric_runtime_not_legacy_engine(self, caplog):
        settings = _settings(VOICE_AGENT_RUNTIME_MODE="main_llm_agent")
        mock_engine = MagicMock()
        mock_engine.handle_turn = AsyncMock()

        with patch("app.ws.conversation_relay.get_engine", return_value=mock_engine), patch(
            "app.brain.eric_dialogue_brain.get_dialogue_brain",
        ) as mock_brain:
            captured, stats = await _run_dispatch(
                settings,
                "What is your name?",
                caplog=caplog,
            )

        mock_engine.handle_turn.assert_not_called()
        mock_brain.assert_not_called()
        assert stats.responses_sent >= 1
        response_text = " ".join(m.get("token", "") for m in captured)
        assert "My name is Eric" in response_text
        assert "voice_turn_handler" in caplog.text
        assert "mode=main_llm_agent" in caplog.text
        assert "handler=main_llm_agent" in caplog.text
        assert "conversationrelay_response_ready" in caplog.text
        assert "runtime_mode=main_llm_agent" in caplog.text
        assert "main_llm_runtime_start" in caplog.text or "brain_runtime_start" in caplog.text
        assert "main_llm_agent_decision" in caplog.text or "brain_decision" in caplog.text
        assert "eric_runtime_start" not in caplog.text
        assert "eric_supervisor_decision" not in caplog.text
        assert "intent_contract_resolved" not in caplog.text
        assert "llm_brain_decision" not in caplog.text
        assert "runtime_mode=legacy_v410" not in caplog.text

    async def test_legacy_v410_uses_realtime_pipeline_engine(self):
        settings = _settings(VOICE_AGENT_RUNTIME_MODE="legacy_v410")
        mock_engine = MagicMock()
        mock_engine.handle_turn = AsyncMock()
        mock_runtime = MagicMock()
        mock_runtime.handle_turn = AsyncMock()

        with patch("app.ws.conversation_relay.get_engine", return_value=mock_engine), patch(
            "app.ws.conversation_relay.get_eric_runtime",
            return_value=mock_runtime,
        ):
            await _run_dispatch(settings, "What is your name?")

        mock_engine.handle_turn.assert_called_once()
        mock_runtime.handle_turn.assert_not_called()

    async def test_unknown_mode_does_not_call_legacy_engine(self, caplog):
        settings = _settings(VOICE_AGENT_RUNTIME_MODE="unknown_mode")
        mock_engine = MagicMock()
        mock_engine.handle_turn = AsyncMock()
        mock_runtime = MagicMock()
        mock_runtime.handle_turn = AsyncMock()
        caplog.set_level(logging.ERROR)

        with patch("app.ws.conversation_relay.get_engine", return_value=mock_engine), patch(
            "app.ws.conversation_relay.get_eric_runtime",
            return_value=mock_runtime,
        ):
            await _run_dispatch(settings, "Hello")

        mock_engine.handle_turn.assert_not_called()
        mock_runtime.handle_turn.assert_not_called()
        assert "runtime_mode_mismatch" in caplog.text


class TestHealthLiveTurnHandler:
    def test_health_includes_live_turn_handler(self, monkeypatch):
        monkeypatch.setenv("VOICE_AGENT_RUNTIME_MODE", "main_llm_agent")
        from app.config import get_settings

        get_settings.cache_clear()
        from fastapi.testclient import TestClient
        from app.main import create_app

        client = TestClient(create_app())
        resp = client.get("/health")
        data = resp.json()
        assert data["runtime_mode"] == "main_llm_agent"
        assert data["live_turn_handler"] == "main_llm_agent"
