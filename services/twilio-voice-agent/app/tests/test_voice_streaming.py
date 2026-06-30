"""Streaming Response Engine — semantic buffer and live TTS chunk emission."""
from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest

from app.runtime.voice_commerce_runtime import StreamingResponseBuffer, VoiceCommerceRuntime
from app.state.models import SessionState


def test_buffer_emits_on_sentence_boundary():
    buf = StreamingResponseBuffer()
    buf.feed("I found your order. ")
    chunks = buf.drain_ready()
    assert chunks == ["I found your order."]
    assert buf.pending == ""


def test_buffer_holds_incomplete_sentence():
    buf = StreamingResponseBuffer()
    buf.feed("I found your")
    assert buf.drain_ready() == []
    buf.feed(" order.")
    chunks = buf.drain_ready()
    assert chunks == ["I found your order."]


def test_buffer_emits_on_comma_clause():
    buf = StreamingResponseBuffer()
    buf.feed("I found your order, and it shipped yesterday.")
    chunks = buf.drain_ready()
    assert chunks[0] == "I found your order,"
    assert "shipped" in chunks[1]


def test_buffer_emits_on_conjunction_pause():
    buf = StreamingResponseBuffer()
    buf.feed("It is paid and it shipped today.")
    chunks = buf.drain_ready()
    assert chunks[0] == "It is paid"
    assert chunks[1].startswith("and it shipped")


def test_buffer_fallback_at_eighteen_words():
    buf = StreamingResponseBuffer()
    buf.feed(
        "one two three four five six seven eight nine ten "
        "eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"
    )
    chunks = buf.drain_ready()
    assert len(chunks) >= 1
    assert len(chunks[0].split()) <= 18


def test_buffer_never_splits_order_number():
    buf = StreamingResponseBuffer()
    text = (
        "one two three four five six seven eight nine ten "
        "eleven twelve order 47908 is paid and shipped out today now"
    )
    buf.feed(text)
    chunks = buf.drain_ready()
    for chunk in chunks:
        if "order" in chunk.lower() or "47908" in chunk:
            assert "order 47908" in chunk


def test_buffer_never_splits_price():
    buf = StreamingResponseBuffer()
    buf.feed("Your total is $90.99 for this order today.")
    chunks = buf.drain_ready()
    assert any("$90.99" in c for c in chunks)


def test_buffer_never_splits_name():
    buf = StreamingResponseBuffer()
    buf.feed("I see this order is for John Smith, and it shipped.")
    chunks = buf.drain_ready()
    for chunk in chunks:
        if "John" in chunk or "Smith" in chunk:
            assert "John Smith" in chunk


def test_buffer_flush_emits_remainder():
    buf = StreamingResponseBuffer()
    buf.feed("Got it")
    assert buf.drain_ready() == []
    assert buf.flush() == ["Got it"]


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="stream",
        call_sid="CAstream1",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


@pytest.mark.asyncio
async def test_emit_stream_chunks_use_play_immediately():
    runtime = VoiceCommerceRuntime(settings=type("S", (), {"OPENAI_API_KEY": "k"})())
    session = _session()
    captured: list[dict] = []

    async def capture(msg: dict):
        captured.append(msg)

    emitted = await runtime._emit_stream_speech_chunks(
        session, capture, ["I found your order."],
    )
    assert len(emitted) == 1
    assert captured[0]["play_immediately"] is True
    assert "order" in captured[0]["token"]


@pytest.mark.asyncio
async def test_speak_streaming_llm_emits_before_brain_returns():
    runtime = VoiceCommerceRuntime(
        settings=type("S", (), {"OPENAI_API_KEY": "k", "VOICE_LLM_STREAM_ENABLED": True})(),
    )
    session = _session()
    captured: list[dict] = []
    brain_done = asyncio.Event()

    async def capture(msg: dict):
        captured.append(msg)

    async def fake_brain(on_token):
        await on_token("I found ")
        await on_token("your order. ")
        await on_token("It shipped yesterday.")
        brain_done.set()
        return "I found your order. It shipped yesterday.", [], []

    with patch.object(runtime._brain, "run_turn", side_effect=fake_brain):
        final, tools, results, parts = await runtime._speak_streaming_llm(
            session,
            "check my order",
            capture,
            on_token_source=lambda cb: fake_brain(cb),
        )

    assert brain_done.is_set()
    assert final.endswith("yesterday.")
    assert parts
    play_tokens = [m for m in captured if m.get("play_immediately")]
    assert play_tokens
    assert any(m.get("last") for m in captured)


@pytest.mark.asyncio
async def test_streaming_skipped_when_interrupted():
    runtime = VoiceCommerceRuntime(settings=type("S", (), {"OPENAI_API_KEY": "k"})())
    session = _session(voice_interrupted=True)
    captured: list[dict] = []

    async def capture(msg: dict):
        captured.append(msg)

    async def fake_brain(on_token):
        await on_token("Should not speak")
        return "Should not speak", [], []

    _, _, _, parts = await runtime._speak_streaming_llm(
        session,
        "hello",
        capture,
        on_token_source=lambda cb: fake_brain(cb),
    )
    assert parts == []
    assert captured == []
