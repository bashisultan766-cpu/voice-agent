"""Interrupt-aware TTS delivery and micro-chunking."""
from __future__ import annotations

import asyncio

import pytest

from app.state.models import SessionState
from app.ws.conversation_relay import _clear_pending_tts_queue
from app.ws.conversation_relay_sender import (
    ConversationRelayOutbound,
    ConversationRelayStats,
    release_speech_lock,
    split_voice_speech_chunks,
    send_text_to_conversation_relay,
)


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="int",
        call_sid="CAinterrupt1",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


def test_split_voice_speech_chunks_one_sentence_short():
    chunks = split_voice_speech_chunks("Your order shipped yesterday.")
    assert chunks == ["Your order shipped yesterday."]


def test_split_voice_speech_chunks_multiple_sentences():
    chunks = split_voice_speech_chunks(
        "I found your order. It is paid and shipped. Anything else?"
    )
    assert len(chunks) == 3
    assert all(len(c.split()) <= 12 for c in chunks)


def test_split_voice_speech_chunks_long_sentence():
    text = (
        "This is a very long sentence that should be broken into multiple "
        "short chunks so the caller can interrupt between phrases easily."
    )
    chunks = split_voice_speech_chunks(text)
    assert len(chunks) >= 2
    assert all(len(c.split()) <= 12 for c in chunks)


@pytest.mark.asyncio
async def test_send_skipped_when_session_interrupted():
    session = _session(voice_interrupted=True)
    captured: list[dict] = []

    async def capture(msg: dict):
        captured.append(msg)

    result = await send_text_to_conversation_relay(
        capture, "Hello there.", session=session,
    )
    assert result.skipped
    assert result.reason == "interrupted"
    assert captured == []
    assert session.is_speaking is False


@pytest.mark.asyncio
async def test_send_cancels_mid_chunk_on_interrupt():
    session = _session()
    captured: list[dict] = []

    async def capture(msg: dict):
        captured.append(msg)
        if len(captured) == 1:
            session.voice_interrupted = True
            release_speech_lock(session)

    long_text = ". ".join(
        ["Sentence number {} has enough words to chunk".format(i) for i in range(1, 6)]
    ) + "."
    result = await send_text_to_conversation_relay(
        capture, long_text, session=session,
    )
    assert result.reason == "interrupted"
    assert len(captured) == 1
    assert session.is_speaking is False


@pytest.mark.asyncio
async def test_outbound_cancel_speech_clears_buffer():
    from app.config import Settings

    session = _session()
    captured: list[dict] = []

    async def capture(msg: dict):
        captured.append(msg)

    outbound = ConversationRelayOutbound(
        capture, Settings(OPENAI_API_KEY="k"), session.call_sid,
        ConversationRelayStats(), session=session,
    )
    await outbound.engine_send({
        "type": "text",
        "token": "Partial response still buffering",
        "last": False,
    })
    outbound.cancel_speech()
    await outbound.engine_send({"type": "text", "token": "", "last": True})
    assert captured == []
    assert session.is_speaking is False
    assert session.speech_lock is False


@pytest.mark.asyncio
async def test_speech_lock_blocks_guarded_send_after_cancel():
    from app.config import Settings

    session = _session()
    captured: list[dict] = []

    async def capture(msg: dict):
        captured.append(msg)

    outbound = ConversationRelayOutbound(
        capture, Settings(OPENAI_API_KEY="k"), session.call_sid,
        ConversationRelayStats(), session=session,
    )
    await outbound.engine_send({
        "type": "text",
        "token": "First phrase ships before interrupt.",
        "last": True,
    })
    assert len(captured) == 1
    assert session.speech_lock is False

    outbound.cancel_speech()
    await outbound.engine_send({
        "type": "text",
        "token": "This must never reach Twilio after interrupt.",
        "last": True,
    })
    assert len(captured) == 1
    assert session.speech_lock is False


def test_clear_pending_tts_queue_drops_text_only():
    q: asyncio.Queue = asyncio.Queue()
    q.put_nowait({"type": "text", "token": "one", "last": False})
    q.put_nowait({"type": "text", "token": "two", "last": True})
    q.put_nowait({"type": "end"})
    dropped = _clear_pending_tts_queue(q)
    assert dropped == 2
    remaining = []
    while not q.empty():
        remaining.append(q.get_nowait())
    assert len(remaining) == 1
    assert remaining[0]["type"] == "end"
