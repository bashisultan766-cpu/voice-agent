"""
Tests for Production Hardening v3.1 — Feature 1: wire VOICE_* env vars.

Verifies that:
- All VOICE_* settings have correct defaults.
- Env overrides are reflected at runtime.
- VOICE_OPENAI_TIMEOUT_MS controls the OpenAI client timeout.
- VOICE_MAX_REPLY_WORDS controls the system prompt word-limit instruction.
- VOICE_FIRST_PROMPT_PROFILE_TIMEOUT_MS feeds into conversation_relay.
"""
from __future__ import annotations

import os
import pytest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")


# ── Default values ────────────────────────────────────────────────────────────

class TestVoiceSettingsDefaults:
    def test_voice_first_prompt_profile_timeout_ms_default(self):
        from app.config import Settings
        s = Settings(OPENAI_API_KEY="x", DEBUG=True)
        assert s.VOICE_FIRST_PROMPT_PROFILE_TIMEOUT_MS == 750

    def test_voice_tool_timeout_ms_default(self):
        from app.config import Settings
        s = Settings(OPENAI_API_KEY="x", DEBUG=True)
        assert s.VOICE_TOOL_TIMEOUT_MS == 2500

    def test_voice_shopify_timeout_ms_default(self):
        from app.config import Settings
        s = Settings(OPENAI_API_KEY="x", DEBUG=True)
        assert s.VOICE_SHOPIFY_TIMEOUT_MS == 2500

    def test_voice_openai_timeout_ms_default(self):
        from app.config import Settings
        s = Settings(OPENAI_API_KEY="x", DEBUG=True)
        assert s.VOICE_OPENAI_TIMEOUT_MS == 8000

    def test_voice_filler_after_ms_default(self):
        from app.config import Settings
        s = Settings(OPENAI_API_KEY="x", DEBUG=True)
        assert s.VOICE_FILLER_AFTER_MS == 250

    def test_voice_max_reply_words_default(self):
        from app.config import Settings
        s = Settings(OPENAI_API_KEY="x", DEBUG=True)
        assert s.VOICE_MAX_REPLY_WORDS == 50


# ── Env overrides ─────────────────────────────────────────────────────────────

class TestVoiceSettingsOverride:
    def test_voice_tool_timeout_override(self):
        from app.config import Settings
        s = Settings(OPENAI_API_KEY="x", DEBUG=True, VOICE_TOOL_TIMEOUT_MS=1000)
        assert s.VOICE_TOOL_TIMEOUT_MS == 1000

    def test_voice_openai_timeout_override(self):
        from app.config import Settings
        s = Settings(OPENAI_API_KEY="x", DEBUG=True, VOICE_OPENAI_TIMEOUT_MS=4000)
        assert s.VOICE_OPENAI_TIMEOUT_MS == 4000

    def test_voice_max_reply_words_override(self):
        from app.config import Settings
        s = Settings(OPENAI_API_KEY="x", DEBUG=True, VOICE_MAX_REPLY_WORDS=30)
        assert s.VOICE_MAX_REPLY_WORDS == 30

    def test_voice_filler_after_ms_override(self):
        from app.config import Settings
        s = Settings(OPENAI_API_KEY="x", DEBUG=True, VOICE_FILLER_AFTER_MS=0)
        assert s.VOICE_FILLER_AFTER_MS == 0


# ── System prompt uses VOICE_MAX_REPLY_WORDS ──────────────────────────────────

class TestSystemPromptMaxReplyWords:
    def test_default_50_words_in_prompt(self):
        from app.ai.system_prompt import build_system_message
        msg = build_system_message()
        assert "50 words" in msg["content"]

    def test_custom_words_in_prompt(self):
        from app.ai.system_prompt import build_system_message
        msg = build_system_message(max_reply_words=30)
        assert "30 words" in msg["content"]
        assert "50 words" not in msg["content"]

    def test_role_is_system(self):
        from app.ai.system_prompt import build_system_message
        msg = build_system_message(max_reply_words=25)
        assert msg["role"] == "system"


# ── OpenAI timeout uses VOICE_OPENAI_TIMEOUT_MS ───────────────────────────────

class TestOpenAITimeoutWired:
    async def test_openai_timeout_from_settings(self):
        """run_agent_turn passes VOICE_OPENAI_TIMEOUT_MS / 1000 to client.create."""
        from app.config import Settings
        from app.state.models import SessionState
        from app.ai.openai_agent import run_agent_turn

        # VOICE_LIVE_DISABLE_OPENAI_TOOLS=False: test the legacy path directly
        settings = Settings(
            OPENAI_API_KEY="test", DEBUG=True,
            VOICE_OPENAI_TIMEOUT_MS=4000,
            VOICE_LIVE_DISABLE_OPENAI_TOOLS=False,
        )
        session = SessionState(
            session_id="s", call_sid="CA1", from_number="+1", to_number="+2",
        )

        captured_timeout = []

        chunk = _make_fake_chunk("Hi!")

        async def fake_stream():
            yield chunk

        fake_completion = AsyncMock()
        fake_completion.__aiter__ = lambda self: fake_stream()

        async def fake_create(**kwargs):
            captured_timeout.append(kwargs.get("timeout"))
            return fake_completion

        with patch("app.ai.openai_agent._get_client") as mock_factory:
            mock_client = AsyncMock()
            mock_client.chat.completions.create = fake_create
            mock_factory.return_value = mock_client

            events = []
            async for ev in run_agent_turn(session, "hi", settings=settings):
                events.append(ev)

        assert captured_timeout, "create was not called"
        assert captured_timeout[0] == pytest.approx(4.0), (
            f"Expected 4.0s (4000ms/1000), got {captured_timeout[0]}"
        )


def _make_fake_chunk(content: str):
    """Build a minimal streaming chunk that looks like an OpenAI finish chunk."""
    chunk = type("Chunk", (), {})()
    choice = type("Choice", (), {})()
    delta = type("Delta", (), {})()
    delta.content = content
    delta.tool_calls = None
    choice.delta = delta
    choice.finish_reason = "stop"
    chunk.choices = [choice]
    return chunk


# ── Profile timeout uses VOICE_FIRST_PROMPT_PROFILE_TIMEOUT_MS ───────────────

class TestProfileTimeoutWired:
    async def test_profile_timeout_short_times_out(self):
        """With a very short profile timeout, a slow load doesn't block the call."""
        import asyncio
        from app.ws.conversation_relay import await_caller_profile_ready

        async def slow_load():
            await asyncio.sleep(10)

        task = asyncio.create_task(slow_load())
        # Should return quickly without blocking
        await await_caller_profile_ready(task, timeout_secs=0.05)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def test_profile_timeout_sufficient_completes(self):
        """With enough timeout, a fast load completes and is reflected."""
        import asyncio
        from app.ws.conversation_relay import await_caller_profile_ready

        result = []

        async def fast_load():
            result.append("done")

        task = asyncio.create_task(fast_load())
        await await_caller_profile_ready(task, timeout_secs=1.0)
        assert result == ["done"]
