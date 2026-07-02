"""v4.12 — Twilio welcomeGreeting first message tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

_EXPECTED_GREETING = (
    "Hello! Thank you for calling SureShot Books. How can I help you today?"
)


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    from app.config import get_settings
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class TestV412FirstMessage:
    def test_twiml_contains_welcome_greeting_when_enabled(self, monkeypatch):
        monkeypatch.setenv("VOICE_WELCOME_GREETING_ENABLED", "true")
        from app.config import get_settings
        get_settings.cache_clear()
        from app.api.twilio_voice import _conversation_relay_twiml
        from app.config import Settings

        s = Settings(
            OPENAI_API_KEY="test",
            DEBUG=True,
            PUBLIC_BASE_URL="https://test.example.com",
            VOICE_WELCOME_GREETING_ENABLED=True,
            VOICE_WELCOME_GREETING=_EXPECTED_GREETING,
            VOICE_WELCOME_GREETING_INTERRUPTIBLE="any",
        )
        xml = _conversation_relay_twiml(
            ws_url="wss://test.example.com/ws",
            call_sid="CA412",
            from_number="+15550004121",
            to_number="+15550004122",
            settings=s,
            welcome_greeting=_EXPECTED_GREETING,
            include_welcome=True,
        )
        assert "welcomeGreeting" in xml
        assert _EXPECTED_GREETING in xml
        assert 'welcomeGreetingInterruptible="any"' in xml

    def test_twiml_omits_welcome_greeting_when_disabled(self, monkeypatch):
        from app.api.twilio_voice import _conversation_relay_twiml
        from app.config import Settings

        s = Settings(
            OPENAI_API_KEY="test",
            DEBUG=True,
            PUBLIC_BASE_URL="https://test.example.com",
            VOICE_WELCOME_GREETING_ENABLED=False,
        )
        xml = _conversation_relay_twiml(
            ws_url="wss://test.example.com/ws",
            call_sid="CA412B",
            from_number="+1",
            to_number="+2",
            settings=s,
            welcome_greeting=None,
            include_welcome=False,
        )
        assert "welcomeGreeting" not in xml

    def test_no_warmly_in_greeting(self):
        from app.config import Settings
        s = Settings(
            OPENAI_API_KEY="test",
            DEBUG=True,
            VOICE_WELCOME_GREETING=_EXPECTED_GREETING,
        )
        assert "[warmly]" not in s.VOICE_WELCOME_GREETING.lower()

    def test_inbound_endpoint_greeting(self, monkeypatch):
        monkeypatch.setenv("VOICE_WELCOME_GREETING_ENABLED", "true")
        monkeypatch.setenv("VOICE_WELCOME_GREETING", _EXPECTED_GREETING)
        from app.config import get_settings
        get_settings.cache_clear()
        from fastapi.testclient import TestClient
        from app.main import create_app

        client = TestClient(create_app())
        resp = client.post(
            "/voice/twilio/agent/inbound",
            data={"CallSid": "CA412C", "From": "+15550004123", "To": "+15550004124"},
        )
        assert resp.status_code == 200
        assert _EXPECTED_GREETING in resp.text
        assert "[warmly]" not in resp.text.lower()

    @pytest.mark.asyncio
    async def test_resume_call_uses_resume_greeting_not_welcome(self, monkeypatch):
        monkeypatch.setenv("VOICE_WELCOME_GREETING_ENABLED", "true")
        from unittest.mock import AsyncMock, patch
        from app.api.twilio_voice import _resolve_welcome_greeting
        from app.config import get_settings

        settings = get_settings()
        with patch(
            "app.api.twilio_voice._is_resume_call",
            AsyncMock(return_value=True),
        ):
            greeting, include = await _resolve_welcome_greeting("+15550004125", settings)
        assert include is True
        assert "continue from where we left off" in (greeting or "").lower()
        assert _EXPECTED_GREETING not in (greeting or "")
