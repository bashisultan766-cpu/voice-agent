"""v4.11.1 — WebSocket output delivery integration tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("VOICE_AGENT_RUNTIME_MODE", "eric_agent_runtime")


def _settings(**overrides):
    from app.config import Settings
    defaults = dict(
        OPENAI_API_KEY="test",
        DEBUG=True,
        VOICE_AGENT_RUNTIME_MODE="eric_agent_runtime",
        VOICE_CR_TEXT_INTERRUPTIBLE=True,
        VOICE_CR_TEXT_PREEMPTIBLE=False,
        VOICE_LANGUAGE="en-US",
    )
    defaults.update(overrides)
    return Settings(**defaults)


def _outbound():
    from app.ws.conversation_relay_sender import ConversationRelayOutbound, ConversationRelayStats

    captured: list[dict] = []
    stats = ConversationRelayStats()

    async def capture(msg: dict):
        captured.append(msg)

    outbound = ConversationRelayOutbound(capture, _settings(), "CA0004111", stats)
    outbound.set_turn(1)
    return outbound, captured, stats


async def _simulate_engine_send(outbound, text: str) -> None:
    """Simulate v4.11 engine/runtime two-message send pattern."""
    await outbound.engine_send({
        "type": "text",
        "token": text,
        "last": False,
        "interruptible": True,
    })
    await outbound.engine_send({
        "type": "text",
        "token": "",
        "last": True,
    })


@pytest.mark.asyncio
class TestWSOutputDelivery:
    async def test_small_talk_sends_text_token(self):
        from app.brain.eric_policy import get_small_talk_response

        outbound, captured, stats = _outbound()
        text = get_small_talk_response("small_talk")
        await _simulate_engine_send(outbound, text)
        assert stats.responses_sent == 1
        assert captured[0]["type"] == "text"
        assert captured[0]["last"] is True
        assert "doing well" in captured[0]["token"].lower()

    async def test_identity_sends_eric(self):
        from app.brain.eric_policy import get_small_talk_response

        outbound, captured, stats = _outbound()
        text = get_small_talk_response("identity_question")
        await _simulate_engine_send(outbound, text)
        assert stats.responses_sent == 1
        assert "Eric" in captured[0]["token"]

    async def test_vague_book_asks_isbn(self):
        from app.brain.eric_policy import get_small_talk_response

        outbound, captured, stats = _outbound()
        text = get_small_talk_response("vague_book_request")
        await _simulate_engine_send(outbound, text)
        assert stats.responses_sent == 1
        assert "ISBN" in captured[0]["token"] or "title" in captured[0]["token"].lower()

    async def test_skip_turn_no_outbound(self):
        from app.agent_runtime.runtime import get_eric_runtime
        from app.ws.conversation_relay_sender import ConversationRelayOutbound, ConversationRelayStats

        captured: list[dict] = []
        stats = ConversationRelayStats()

        async def capture(msg: dict):
            captured.append(msg)

        outbound = ConversationRelayOutbound(capture, _settings(), "CA0004111", stats)

        async def send(msg: dict):
            await outbound.engine_send(msg)

        from app.state.models import SessionState
        session = SessionState(
            session_id="s4111",
            call_sid="CA0004111",
            from_number="+15550001111",
            to_number="+15559998888",
        )
        result = await get_eric_runtime(_settings()).handle_turn(
            session, "Wait one second", send,
        )
        assert result.skip_turn
        assert len(captured) == 0

    async def test_incomplete_isbn_hold_no_final_answer(self):
        outbound, captured, stats = _outbound()
        await outbound.engine_send({
            "type": "text",
            "token": "Go ahead, I'm listening.",
            "last": False,
            "interruptible": True,
        })
        await outbound.engine_send({"type": "text", "token": "", "last": True})
        assert stats.responses_sent == 1
        assert "listening" in captured[0]["token"].lower()

    async def test_legacy_v410_sends_text_token(self):
        from unittest.mock import AsyncMock, patch
        from app.pipeline.engine import RealtimePipelineEngine
        from app.workers.base import WorkerBundle
        from app.state.models import SessionState
        from app.ws.conversation_relay_sender import ConversationRelayOutbound, ConversationRelayStats

        captured: list[dict] = []
        stats = ConversationRelayStats()

        async def capture(msg: dict):
            captured.append(msg)

        settings = _settings(VOICE_AGENT_RUNTIME_MODE="legacy_v410")
        outbound = ConversationRelayOutbound(capture, settings, "CA0004111", stats)
        outbound.set_turn(1)

        async def send(msg: dict):
            await outbound.engine_send(msg)

        engine = RealtimePipelineEngine(settings=settings)
        session = SessionState(
            session_id="s4111",
            call_sid="CA0004111",
            from_number="+15550001111",
            to_number="+15559998888",
        )

        async def fake_stream(sess, caller_text, ir, wb, ctx, settings=None):
            yield {"type": "text_token", "token": "Legacy hello."}
            yield {"type": "turn_done"}

        with patch.object(engine._orchestrator, "run", AsyncMock(return_value=WorkerBundle())), \
             patch.object(engine._composer, "stream_response", fake_stream):
            await engine.handle_turn(session, "search for Dune by Frank Herbert", send)

        assert stats.responses_sent >= 1
        assert any(m.get("last") is True for m in captured)

    async def test_empty_response_triggers_fallback(self):
        outbound, captured, stats = _outbound()
        await outbound.engine_send({"type": "text", "token": "", "last": True})
        await outbound._send_fallback("CA0004", True, False, "en-US")
        assert stats.responses_sent >= 1
        assert captured[0]["last"] is True

    async def test_stats_counters(self):
        from app.ws.conversation_relay_sender import ConversationRelayStats

        stats = ConversationRelayStats()
        stats.prompts_received = 3
        stats.assembled_turns = 2
        stats.responses_sent = 2
        assert stats.prompts_received == 3
        assert stats.assembled_turns == 2
        assert stats.responses_sent == 2


def test_error_message_log_pattern(caplog):
    import logging
    caplog.set_level(logging.ERROR)
    logger = logging.getLogger("app.ws.conversation_relay")
    logger.error(
        "conversationrelay_error sid=%s description=%s last_outbound=%s",
        "CA0004", "Invalid message received", "text",
    )
    assert "conversationrelay_error" in caplog.text
    assert "Invalid message received" in caplog.text
