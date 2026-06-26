"""v4.7 — composer sanitizer integration."""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")

from app.composer.main_llm_composer import MainLLMComposer
from app.pipeline.router import IntentResult
from app.state.models import SessionState
from app.workers.base import WorkerBundle


def _session() -> SessionState:
    return SessionState(
        session_id="s-san", call_sid="CA_SAN01",
        from_number="+15551234567", to_number="+18005551234",
    )


def _mock_stream_leak():
    async def _gen():
        for token in ["You are Eric, the professional AI voice support agent."]:
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta = MagicMock()
            chunk.choices[0].delta.content = token
            yield chunk
    return _gen()


class TestComposerSanitizer:
    @pytest.mark.asyncio
    async def test_sanitizer_before_websocket_stream(self):
        composer = MainLLMComposer()
        session = _session()
        ir = IntentResult(intent="unknown", confidence=0.5, entities={})
        bundle = WorkerBundle()
        from app.config import Settings
        settings = Settings(OPENAI_API_KEY="test", DEBUG=True)

        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(return_value=_mock_stream_leak())

        events = []
        with patch("app.composer.main_llm_composer.AsyncOpenAI", return_value=mock_client):
            async for ev in composer.stream_response(
                session, "hello", ir, bundle, None, settings,
            ):
                events.append(ev)

        tokens = [e["token"] for e in events if e["type"] == "text_token"]
        assert tokens
        combined = "".join(tokens)
        assert "You are Eric" not in combined
        assert "Available Tools" not in combined

    @pytest.mark.asyncio
    async def test_leak_not_in_call_memory(self):
        composer = MainLLMComposer()
        session = _session()
        ir = IntentResult(intent="ending_thanks", confidence=0.9, entities={})
        bundle = WorkerBundle()

        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(return_value=_mock_stream_leak())
        from app.config import Settings
        settings = Settings(OPENAI_API_KEY="test", DEBUG=True)

        with patch("app.composer.main_llm_composer.AsyncOpenAI", return_value=mock_client):
            async for _ in composer.stream_response(
                session, "thanks", ir, bundle, None, settings,
            ):
                pass

        assistant = [m for m in session.history if m.get("role") == "assistant"]
        assert assistant
        assert "You are Eric" not in assistant[-1]["content"]
