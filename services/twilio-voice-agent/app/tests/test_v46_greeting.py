"""v4.6 tests — SureShot greeting and fast greeting path."""
from __future__ import annotations

import os
import pytest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.dialogue.greeting import (
    GREETING_NEW,
    GREETING_RETURNING,
    build_first_response_greeting,
    build_twiml_greeting,
    greeting_has_forbidden_phrases,
    greeting_word_count,
)
from app.state.models import SessionState
from app.composer.main_llm_composer import MainLLMComposer, _deterministic_response
from app.pipeline.router import IntentResult


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="s-g", call_sid="CA_G001",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


class TestSureShotGreetingText:
    def test_new_session_greeting(self):
        assert GREETING_NEW == (
            "Hello, welcome to SureShot Books. How can I help you today?"
        )

    def test_returning_greeting(self):
        assert "welcome back" in GREETING_RETURNING.lower()

    def test_twiml_greeting_under_15_words(self):
        assert greeting_word_count(GREETING_NEW) <= 15

    def test_no_ai_mention(self):
        assert not greeting_has_forbidden_phrases(GREETING_NEW)
        assert not greeting_has_forbidden_phrases(GREETING_RETURNING)

    def test_recognized_caller_welcome_back(self):
        s = _session(is_returning_caller=True)
        text = build_twiml_greeting(returning=True)
        assert "welcome back" in text.lower()

    def test_first_response_after_twiml_no_duplicate(self):
        s = _session()
        text = build_first_response_greeting(s, greeted_already=True)
        assert "welcome" not in text.lower() or "sure" in text.lower()


class TestDeterministicGreetingComposer:
    def test_greeting_intent_deterministic(self):
        s = _session()
        ir = IntentResult(intent="greeting", confidence=0.9)
        text = _deterministic_response(s, ir)
        assert text == GREETING_NEW

    async def test_greeting_no_openai_call(self):
        composer = MainLLMComposer()
        s = _session()
        ir = IntentResult(intent="greeting", confidence=0.9)
        from app.config import Settings
        settings = Settings(OPENAI_API_KEY="test", DEBUG=True)

        with patch("app.composer.main_llm_composer.AsyncOpenAI") as mock_client:
            tokens = []
            async for event in composer.stream_response(
                s, "hello", ir, __import__("app.workers.base", fromlist=["WorkerBundle"]).WorkerBundle(),
                None, settings,
            ):
                if event.get("type") == "text_token":
                    tokens.append(event["token"])
            mock_client.assert_not_called()
        assert "SureShot" in "".join(tokens)


class TestInboundTwimlGreeting:
    def test_twiml_sureshot_greeting(self):
        from fastapi.testclient import TestClient
        from app.config import get_settings
        get_settings.cache_clear()
        from app.main import create_app
        client = TestClient(create_app())
        resp = client.post(
            "/voice/twilio/inbound",
            data={"CallSid": "CA_G2", "From": "+15550001111", "To": "+15550002222"},
        )
        assert "SureShot Books" in resp.text
        assert "welcomeGreeting" in resp.text

    async def test_twiml_elevenlabs_when_configured(self):
        from app.api.twilio_voice import _conversation_relay_twiml
        from app.config import Settings
        s = Settings(
            OPENAI_API_KEY="test",
            DEBUG=True,
            PUBLIC_BASE_URL="https://test.example.com",
            VOICE_TTS_PROVIDER="ElevenLabs",
            VOICE_ID="voice123",
            VOICE_MODEL="flash_v2_5",
        )
        xml = _conversation_relay_twiml(
            ws_url="wss://test.example.com/ws",
            call_sid="CA",
            from_number="+1",
            to_number="+2",
            settings=s,
        )
        assert "ttsProvider" in xml and "ElevenLabs" in xml
        assert "voice123-flash_v2_5" in xml

    def test_twiml_google_fallback_no_voice_id(self):
        from app.api.twilio_voice import _conversation_relay_twiml
        from app.config import Settings
        s = Settings(
            OPENAI_API_KEY="test",
            DEBUG=True,
            PUBLIC_BASE_URL="https://test.example.com",
            VOICE_TTS_PROVIDER="ElevenLabs",
            VOICE_ID="",
        )
        xml = _conversation_relay_twiml(
            ws_url="wss://test.example.com/ws",
            call_sid="CA",
            from_number="+1",
            to_number="+2",
            settings=s,
        )
        assert "Google.en-US-Neural2-J" in xml
