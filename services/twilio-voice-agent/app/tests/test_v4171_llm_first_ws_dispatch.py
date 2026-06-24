"""v4.17.1 — ConversationRelay dispatch must route llm_first (no silence)."""
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
        VOICE_AGENT_RUNTIME_MODE="llm_first",
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
    from app.agent_runtime import runtime as runtime_module
    from app.agent_runtime import llm_first_runtime as llmf_module
    from app.ws.conversation_relay import dispatch_assembled_turn
    from app.ws.conversation_relay_sender import ConversationRelayOutbound, ConversationRelayStats

    runtime_module._runtime = None
    llmf_module._runtime = None

    captured: list[dict] = []
    stats = ConversationRelayStats()

    async def capture(msg: dict):
        captured.append(msg)

    outbound = ConversationRelayOutbound(capture, settings, "CA41710001", stats)
    outbound.set_turn(1)

    async def send(msg: dict):
        await outbound.engine_send(msg)

    session = _session()
    if caplog is not None:
        caplog.set_level(logging.INFO)

    await dispatch_assembled_turn(settings, session, user_text, send, caller_context=None)
    await outbound.flush()
    return captured, stats


@pytest.mark.asyncio
class TestLLMFirstDispatch:
    async def test_llm_first_turn_gets_response_not_silence(self, caplog):
        settings = _settings(VOICE_AGENT_RUNTIME_MODE="llm_first")
        mock_engine = MagicMock()
        mock_engine.handle_turn = AsyncMock()

        with patch("app.ws.conversation_relay.get_engine", return_value=mock_engine):
            captured, stats = await _run_dispatch(
                settings, "Hello. How are you?", caplog=caplog,
            )

        # Legacy engine must never be touched for llm_first.
        mock_engine.handle_turn.assert_not_called()

        # A spoken response must be produced (no silence).
        response_text = " ".join(m.get("token", "") for m in captured if m.get("type") == "text")
        assert len(response_text.strip()) > 0
        assert stats.responses_sent >= 1

        # Correct handler selected, no mismatch, no legacy attempt.
        assert "voice_turn_handler" in caplog.text
        assert "mode=llm_first" in caplog.text
        assert "handler=llm_first" in caplog.text
        assert "llm_first_turn_started" in caplog.text
        assert "llm_first_turn_completed" in caplog.text
        assert "runtime_mode_mismatch" not in caplog.text
        assert "attempted=legacy_v410" not in caplog.text

    async def test_resolve_handler_is_llm_first(self):
        from app.agent_runtime.runtime import resolve_live_turn_handler

        settings = _settings(VOICE_AGENT_RUNTIME_MODE="llm_first")
        assert resolve_live_turn_handler(settings) == "llm_first"

    async def test_unknown_mode_safe_fallback_responds(self, caplog):
        """Unknown mode logs mismatch but must NOT leave the caller in silence."""
        settings = _settings(VOICE_AGENT_RUNTIME_MODE="unknown_mode")
        mock_engine = MagicMock()
        mock_engine.handle_turn = AsyncMock()
        fake_llmf = MagicMock()
        fake_llmf.handle_turn = AsyncMock()
        caplog.set_level(logging.INFO)

        with patch("app.ws.conversation_relay.get_engine", return_value=mock_engine), patch(
            "app.agent_runtime.llm_first_runtime.get_llm_first_runtime",
            return_value=fake_llmf,
        ):
            await _run_dispatch(settings, "Hello", caplog=caplog)

        # Legacy engine never called; safe fallback (llm_first) IS called.
        mock_engine.handle_turn.assert_not_called()
        fake_llmf.handle_turn.assert_called_once()
        assert "runtime_mode_mismatch" in caplog.text
        assert "attempted=legacy_v410" not in caplog.text
