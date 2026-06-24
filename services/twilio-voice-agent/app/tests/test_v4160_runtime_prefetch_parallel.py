"""v4.16.0 — Runtime parallel prefetch + live log regression tests."""
from __future__ import annotations

import logging
import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


def _settings(**overrides):
    from app.config import Settings
    defaults = dict(
        OPENAI_API_KEY="test",
        DEBUG=True,
        VOICE_AGENT_RUNTIME_MODE="main_llm_agent",
        VOICE_BRAIN_ORCHESTRATOR_ENABLED=True,
        VOICE_SPECULATIVE_PREFETCH_ENABLED=True,
        VOICE_PREFETCH_SCOUT_TIMEOUT_MS=200,
        VOICE_PREFETCH_MAX_WAIT_MS=100,
        ERIC_PROMPT_PACK_ENABLED=True,
        VOICE_LIVE_DISABLE_OPENAI_TOOLS=True,
    )
    defaults.update(overrides)
    return Settings(**defaults)


def _session():
    from app.state.models import SessionState
    return SessionState(
        session_id="s4160r",
        call_sid="CA4160RUN1",
        from_number="+15550004160",
        to_number="+15559998888",
    )


async def _run_turn(settings, user_text: str, *, caplog=None):
    from app.agent_runtime import runtime as runtime_module
    from app.ws.conversation_relay import dispatch_assembled_turn
    from app.ws.conversation_relay_sender import ConversationRelayOutbound, ConversationRelayStats

    runtime_module._runtime = None
    captured: list[dict] = []
    stats = ConversationRelayStats()

    async def capture(msg: dict):
        captured.append(msg)

    outbound = ConversationRelayOutbound(capture, settings, "CA4160RUN1", stats)
    outbound.set_turn(1)

    async def send(msg: dict):
        await outbound.engine_send(msg)

    session = _session()
    if caplog is not None:
        caplog.set_level(logging.INFO)

    await dispatch_assembled_turn(settings, session, user_text, send, caller_context=None)
    await outbound.flush()
    text = " ".join(m.get("token", "") for m in captured)
    return text, caplog


@pytest.mark.asyncio
class TestRuntimePrefetchParallel:
    async def test_brain_orchestrator_called(self, caplog):
        text, _ = await _run_turn(_settings(), "Hello. How are you, brother?", caplog=caplog)
        assert "brain_runtime_start" in caplog.text or "brain_decision" in caplog.text
        assert "help" in text.lower()

    async def test_no_mixed_identifier_message(self, caplog):
        text, _ = await _run_turn(_settings(), "Hello. How are you, brother?", caplog=caplog)
        assert "found 2 items" not in text.lower()
        assert "mixed_identifiers" not in caplog.text.lower() or "brain_runtime" in caplog.text

    async def test_identity_no_hold(self, caplog):
        text, _ = await _run_turn(_settings(), "Your name is Eric. Yes or no?", caplog=caplog)
        assert "skip_turn" not in caplog.text or "brain_hold" not in caplog.text
        assert "eric" in text.lower()

    async def test_hello_no_generic_unknown(self, caplog):
        text, _ = await _run_turn(_settings(), "Hello?", caplog=caplog)
        assert "generic_unknown" not in caplog.text
        assert "here" in text.lower()

    async def test_meta_complaint_no_leak(self):
        text, _ = await _run_turn(_settings(), "Why are you not using LLM?")
        lowered = text.lower()
        assert "openai" not in lowered
        assert "llm brain" not in lowered

    async def test_openai_tools_blocked(self):
        s = _settings()
        assert s.VOICE_LIVE_DISABLE_OPENAI_TOOLS is True

    def test_brain_mode_enabled(self):
        from app.agent_runtime.runtime import is_brain_orchestrator_mode
        assert is_brain_orchestrator_mode(_settings()) is True

    async def test_mixed_identifier_resolver_not_final_intent(self, caplog):
        from app.agent_runtime.commerce_commit_resolver import resolve_commerce_commit
        from app.agent_runtime.commerce_session import get_commerce_session

        commerce = get_commerce_session("CA4160MIX")
        commit = resolve_commerce_commit("Hello. How are you, brother?", commerce, session_state=_session())
        if commit.matched and commit.intent == "mixed_identifiers_detected":
            text, _ = await _run_turn(_settings(), "Hello. How are you, brother?", caplog=caplog)
            assert "found 2 items" not in text.lower()
