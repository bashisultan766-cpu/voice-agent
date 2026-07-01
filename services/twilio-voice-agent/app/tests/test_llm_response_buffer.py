"""Buffered LLM responses — no partial TTS when execution_policy != llm_allowed."""
from __future__ import annotations

import asyncio

import pytest

from app.runtime.execution_policy_resolver import EXECUTION_POLICY_SHORT_CIRCUIT
from app.runtime.voice_commerce_runtime import (
    VoiceCommerceRuntime,
    buffer_llm_response_until_complete,
    llm_streaming_permitted,
)
from app.state.models import SessionState


def test_llm_streaming_permitted_only_for_llm_allowed():
    assert llm_streaming_permitted("llm_allowed") is True
    assert llm_streaming_permitted("short_circuit") is False
    assert llm_streaming_permitted("deterministic") is False


@pytest.mark.asyncio
async def test_buffer_llm_response_until_complete_swallows_tokens():
    tokens_seen: list[str] = []

    async def fake_brain(on_token):
        async def emit(tok: str) -> None:
            tokens_seen.append(tok)
            if on_token:
                await on_token(tok)

        await emit("Partial ")
        await emit("cart reply.")
        return "Final cart confirmation text.", ["add_to_cart"], [("add_to_cart", {"success": True})]

    final, tools, results = await buffer_llm_response_until_complete(fake_brain)
    assert final == "Final cart confirmation text."
    assert tools == ["add_to_cart"]
    assert tokens_seen == ["Partial ", "cart reply."]


@pytest.mark.asyncio
async def test_buffer_falls_back_to_captured_tokens_when_final_empty():
    async def fake_brain(on_token):
        if on_token:
            await on_token("Buffered only text.")
        return "", [], []

    final, _, _ = await buffer_llm_response_until_complete(fake_brain)
    assert final == "Buffered only text."


@pytest.mark.asyncio
async def test_speak_streaming_llm_buffers_when_policy_not_llm_allowed():
    runtime = VoiceCommerceRuntime(
        settings=type("S", (), {"OPENAI_API_KEY": "k", "VOICE_LLM_STREAM_ENABLED": True})(),
    )
    session = SessionState(
        session_id="buf",
        call_sid="CAbuf01",
        from_number="+1",
        to_number="+2",
    )
    captured: list[dict] = []

    async def capture(msg: dict) -> None:
        captured.append(msg)

    async def fake_brain(on_token):
        if on_token:
            await on_token("Got it — added one copy.")
        await asyncio.sleep(0)
        return "Got it — added one copy of Deep Work.", [], []

    final, _, _, streamed = await runtime._speak_streaming_llm(
        session,
        "two copies",
        capture,
        on_token_source=fake_brain,
        execution_policy=EXECUTION_POLICY_SHORT_CIRCUIT,
    )

    assert final == "Got it — added one copy of Deep Work."
    assert streamed == []
    assert captured == []
