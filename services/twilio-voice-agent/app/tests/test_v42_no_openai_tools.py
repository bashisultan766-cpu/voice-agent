"""
v4.2 tests — VOICE_LIVE_DISABLE_OPENAI_TOOLS guard.

Verifies:
- run_agent_turn raises RuntimeError when VOICE_LIVE_DISABLE_OPENAI_TOOLS=True (default).
- Engine never calls run_agent_turn for ANY intent in live voice mode.
- session.history never contains role="tool" or tool_calls after a turn.
- Repeated interruptions leave history in a clean state.
- Config flag defaults to True.
"""
from __future__ import annotations

import asyncio
import os
import pytest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.state.models import SessionState
from app.workers.base import WorkerBundle


def _make_session():
    return SessionState(
        session_id="s-v42", call_sid="CA_V42001",
        from_number="+15551234567", to_number="+18005551234",
    )


def _live_settings(**overrides):
    from app.config import Settings
    defaults = dict(OPENAI_API_KEY="test", DEBUG=True, VOICE_FILLER_AFTER_MS=0)
    defaults.update(overrides)
    return Settings(**defaults)


# ── Config guard ──────────────────────────────────────────────────────────────

class TestLiveOpenAIToolsFlag:
    def test_flag_defaults_to_true(self):
        from app.config import Settings
        s = Settings(OPENAI_API_KEY="x", DEBUG=True)
        assert s.VOICE_LIVE_DISABLE_OPENAI_TOOLS is True

    def test_flag_can_be_disabled(self):
        from app.config import Settings
        s = Settings(OPENAI_API_KEY="x", DEBUG=True, VOICE_LIVE_DISABLE_OPENAI_TOOLS=False)
        assert s.VOICE_LIVE_DISABLE_OPENAI_TOOLS is False


# ── run_agent_turn guard ──────────────────────────────────────────────────────

class TestRunAgentTurnGuard:
    async def test_run_agent_turn_raises_when_flag_enabled(self):
        """run_agent_turn must raise RuntimeError in live voice mode."""
        from app.ai.openai_agent import run_agent_turn
        from app.config import Settings

        settings = Settings(OPENAI_API_KEY="test", DEBUG=True,
                            VOICE_LIVE_DISABLE_OPENAI_TOOLS=True)
        session = _make_session()

        with pytest.raises(RuntimeError, match="VOICE_LIVE_DISABLE_OPENAI_TOOLS"):
            async for _ in run_agent_turn(session, "hello", settings=settings):
                pass

    async def test_run_agent_turn_works_with_flag_disabled(self):
        """run_agent_turn must work when flag is explicitly disabled."""
        from app.ai.openai_agent import run_agent_turn
        from app.config import Settings

        settings = Settings(OPENAI_API_KEY="test", DEBUG=True,
                            VOICE_LIVE_DISABLE_OPENAI_TOOLS=False)
        session = _make_session()

        mock_chunk = type("C", (), {
            "choices": [type("Ch", (), {
                "delta": type("D", (), {"content": "Hi!", "tool_calls": None})(),
                "finish_reason": "stop",
            })()],
        })()

        async def fake_stream():
            yield mock_chunk

        mock_completion = AsyncMock()
        mock_completion.__aiter__ = lambda self: fake_stream()

        with patch("app.ai.openai_agent._get_client") as mock_factory:
            mock_client = AsyncMock()
            mock_client.chat.completions.create = AsyncMock(return_value=mock_completion)
            mock_factory.return_value = mock_client

            events = []
            async for ev in run_agent_turn(session, "Hello", settings=settings):
                events.append(ev)

        assert any(e["type"] == "turn_done" for e in events)


# ── Engine never calls run_agent_turn in live mode ────────────────────────────

class TestEngineNeverCallsRunAgentTurn:
    async def _assert_no_run_agent_turn(self, text: str):
        from app.pipeline.engine import RealtimePipelineEngine
        engine = RealtimePipelineEngine(settings=_live_settings())

        run_agent_called = []

        async def spy_run_agent_turn(*args, **kwargs):
            run_agent_called.append(True)
            yield {"type": "turn_done"}

        async def fake_stream(sess, text, ir, wb, ctx, settings=None):
            yield {"type": "turn_done"}

        with patch("app.pipeline.engine.run_agent_turn", spy_run_agent_turn), \
             patch.object(engine._orchestrator, "run", AsyncMock(return_value=WorkerBundle())), \
             patch.object(engine._composer, "stream_response", fake_stream):
            session = _make_session()
            sent = []
            await engine.handle_turn(session, text, lambda m: _append(sent, m))

        assert not run_agent_called, f"run_agent_turn was called for: {text!r}"

    async def test_greeting_never_calls_run_agent_turn(self):
        await self._assert_no_run_agent_turn("hi there")

    async def test_unknown_intent_never_calls_run_agent_turn(self):
        await self._assert_no_run_agent_turn("xkcd foo bar baz")

    async def test_confirmation_never_calls_run_agent_turn(self):
        await self._assert_no_run_agent_turn("yes that is correct")

    async def test_isbn_search_never_calls_run_agent_turn(self):
        await self._assert_no_run_agent_turn("isbn 9780441172719")

    async def test_order_lookup_never_calls_run_agent_turn(self):
        await self._assert_no_run_agent_turn("where is my order 1042")


# ── History safety ────────────────────────────────────────────────────────────

class TestHistoryNeverHasToolMessages:
    async def test_history_has_no_tool_role_after_turn(self):
        from app.pipeline.engine import RealtimePipelineEngine
        engine = RealtimePipelineEngine(settings=_live_settings())
        session = _make_session()

        async def fake_stream(sess, text, ir, wb, ctx, settings=None):
            yield {"type": "text_token", "token": "Sure!"}
            yield {"type": "turn_done"}

        with patch.object(engine._orchestrator, "run", AsyncMock(return_value=WorkerBundle())), \
             patch.object(engine._composer, "stream_response", fake_stream):
            sent = []
            await engine.handle_turn(session, "isbn 9780441172719",
                                     lambda m: _append(sent, m))

        for msg in session.history:
            assert msg.get("role") != "tool", f"Found role=tool in history: {msg}"
            assert "tool_calls" not in msg, f"Found tool_calls in history: {msg}"

    async def test_history_no_tool_after_interruption(self):
        from app.pipeline.engine import RealtimePipelineEngine
        engine = RealtimePipelineEngine(settings=_live_settings())
        session = _make_session()

        call_count = [0]

        async def slow_stream(sess, text, ir, wb, ctx, settings=None):
            call_count[0] += 1
            await asyncio.sleep(10)  # simulate slow stream
            yield {"type": "turn_done"}

        with patch.object(engine._orchestrator, "run", AsyncMock(return_value=WorkerBundle())), \
             patch.object(engine._composer, "stream_response", slow_stream):
            task = asyncio.create_task(
                engine.handle_turn(session, "hi", lambda m: None)
            )
            await asyncio.sleep(0.02)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        for msg in session.history:
            assert msg.get("role") != "tool"
            assert "tool_calls" not in msg


async def _append(lst, msg):
    lst.append(msg)
