"""v4.11.1 — ConversationRelay outbound sender unit tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


class FakeWebSocket:
    def __init__(self):
        self.sent: list[dict] = []

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)


@pytest.mark.asyncio
class TestConversationRelaySender:
    async def test_sends_type_text_token_last_true(self):
        from app.ws.conversation_relay_sender import send_text_to_conversation_relay

        captured: list[dict] = []

        async def capture(msg: dict):
            captured.append(msg)

        result = await send_text_to_conversation_relay(
            capture,
            "Hello from Eric.",
            sid="CA123456",
            turn=1,
            interruptible=True,
            preemptible=False,
            lang="en-US",
        )
        assert result.sent
        assert len(captured) == 1
        assert captured[0]["type"] == "text"
        assert captured[0]["token"] == "Hello from Eric."
        assert captured[0]["last"] is True
        assert captured[0]["interruptible"] is True
        assert captured[0]["preemptible"] is False
        assert captured[0]["lang"] == "en-US"

    async def test_skips_empty_text(self):
        from app.ws.conversation_relay_sender import send_text_to_conversation_relay

        captured: list[dict] = []

        async def capture(msg: dict):
            captured.append(msg)

        result = await send_text_to_conversation_relay(capture, "   ", sid="CA1")
        assert result.skipped
        assert len(captured) == 0

    async def test_final_chunk_has_last_true(self):
        from app.ws.conversation_relay_sender import send_text_to_conversation_relay

        captured: list[dict] = []

        async def capture(msg: dict):
            captured.append(msg)

        long_text = "A" * 600
        await send_text_to_conversation_relay(capture, long_text, sid="CA1", chunk_size=500)
        assert len(captured) >= 2
        assert captured[-1]["last"] is True
        assert captured[0]["last"] is False


class TestConversationRelaySenderSync:
    def test_masks_pii_in_logs(self):
        from app.ws.conversation_relay_sender import mask_outbound_log_text

        masked = mask_outbound_log_text(
            "Email me at john.doe@example.com please",
            max_chars=160,
        )
        assert "john.doe" not in masked
        assert "@example.com" not in masked

    def test_build_text_payload(self):
        from app.ws.conversation_relay_sender import build_text_payload

        p = build_text_payload("Hi", last=True, preemptible=False)
        assert p == {
            "type": "text",
            "token": "Hi",
            "last": True,
            "interruptible": True,
            "preemptible": False,
        }


@pytest.mark.asyncio
class TestConversationRelaySenderAsync:
    async def test_no_raw_prompt_in_outbound(self):
        from app.ws.conversation_relay_sender import send_text_to_conversation_relay

        captured: list[dict] = []

        async def capture(msg: dict):
            captured.append(msg)

        await send_text_to_conversation_relay(
            capture,
            "You are Eric. Available Tools: search_products",
            sid="CA1",
            call_sid="CA123456789",
        )
        assert captured
        assert "Available Tools" not in captured[0]["token"]
        assert "you are eric" not in captured[0]["token"].lower()

    async def test_outbound_adapter_combines_last_false_then_empty(self):
        from app.config import Settings
        from app.ws.conversation_relay_sender import (
            ConversationRelayOutbound,
            ConversationRelayStats,
        )

        captured: list[dict] = []
        stats = ConversationRelayStats()

        async def capture(msg: dict):
            captured.append(msg)

        settings = Settings(
            OPENAI_API_KEY="test",
            DEBUG=True,
            VOICE_CR_TEXT_INTERRUPTIBLE=True,
            VOICE_CR_TEXT_PREEMPTIBLE=False,
            VOICE_LANGUAGE="en-US",
        )
        outbound = ConversationRelayOutbound(capture, settings, "CA_OUT001", stats)
        outbound.set_turn(1)

        await outbound.engine_send({
            "type": "text",
            "token": "I'm doing well, thank you.",
            "last": False,
            "interruptible": True,
        })
        await outbound.engine_send({
            "type": "text",
            "token": "",
            "last": True,
        })

        assert len(captured) == 1
        assert captured[0]["last"] is True
        assert "doing well" in captured[0]["token"]
        assert stats.responses_sent == 1
