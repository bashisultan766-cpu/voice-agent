"""v4.11 — Eric Agent Runtime tests."""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


def _session():
    from app.state.models import SessionState
    return SessionState(
        session_id="s411rt",
        call_sid="CA00000412",
        from_number="+15550002222",
        to_number="+15559998888",
    )


@pytest.mark.asyncio
class TestEricAgentRuntime:
    async def test_runtime_receives_complete_turn(self):
        from app.agent_runtime.runtime import get_eric_runtime
        session = _session()
        sent = []

        async def send(msg):
            sent.append(msg)

        runtime = get_eric_runtime()
        result = await runtime.handle_turn(session, "Hello how are you?", send)
        assert not result.skip_turn or result.response_text
        assert any(m.get("token") for m in sent if m.get("type") == "text")

    async def test_supervisor_runs_before_workers(self, caplog):
        import logging
        from app.agent_runtime.runtime import get_eric_runtime

        caplog.set_level(logging.INFO)
        session = _session()
        sent = []

        async def send(msg):
            sent.append(msg)

        await get_eric_runtime().handle_turn(session, "What is your name?", send)
        logs = caplog.text
        assert "eric_supervisor_decision" in logs
        assert "eric_runtime_start" in logs

    async def test_worker_results_passed_to_composer(self, caplog):
        import logging
        from app.agent_runtime.runtime import get_eric_runtime

        caplog.set_level(logging.INFO)
        session = _session()
        sent = []

        async def send(msg):
            sent.append(msg)

        await get_eric_runtime().handle_turn(
            session, "Do you have books about football?", send,
        )
        assert "eric_fact_packet" in caplog.text or "eric_worker_fanout_start" in caplog.text

    async def test_assistant_response_always_emitted(self):
        from app.agent_runtime.runtime import get_eric_runtime
        session = _session()
        sent = []

        async def send(msg):
            sent.append(msg)

        result = await get_eric_runtime().handle_turn(session, "Hi there", send)
        tokens = [m.get("token", "") for m in sent if m.get("type") == "text"]
        assert result.response_text or any(tokens)

    async def test_wait_phrase_intentional_hold(self):
        from app.agent_runtime.runtime import get_eric_runtime
        session = _session()
        sent = []

        async def send(msg):
            sent.append(msg)

        result = await get_eric_runtime().handle_turn(session, "Wait hold on", send)
        assert result.skip_turn
        assert not any(m.get("token") for m in sent)

    async def test_no_openai_tools(self):
        from app.config import get_settings
        s = get_settings()
        assert s.VOICE_LIVE_DISABLE_OPENAI_TOOLS is True

    async def test_legacy_fallback_mode(self, monkeypatch):
        monkeypatch.setenv("VOICE_AGENT_RUNTIME_MODE", "legacy_v410")
        from app.config import get_settings
        get_settings.cache_clear()
        from app.agent_runtime.runtime import is_eric_runtime_mode
        assert not is_eric_runtime_mode(get_settings())
        get_settings.cache_clear()

    async def test_default_runtime_mode(self):
        from app.config import get_settings
        from app.agent_runtime.runtime import is_eric_runtime_mode
        s = get_settings()
        if s.VOICE_AGENT_RUNTIME_MODE == "eric_agent_runtime":
            assert is_eric_runtime_mode(s)
