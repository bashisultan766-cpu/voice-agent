"""
Tests for POST /voice/twilio/inbound.

Verifies:
- Returns valid XML with <ConversationRelay>.
- Sets correct WebSocket URL.
- Includes custom parameters.
- Signature validation is skipped when VALIDATE_TWILIO_SIGNATURES=false.
"""
from __future__ import annotations

import os
import pytest
from fastapi.testclient import TestClient

# Patch env before importing the app.
os.environ["APP_ENV"] = "test"
os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ["OPENAI_MODEL"] = "gpt-4o"
os.environ.setdefault("VALIDATE_TWILIO_SIGNATURES", "false")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")
os.environ.setdefault("SHOPIFY_SHOP_DOMAIN", "test.myshopify.com")


def _make_client():
    # Import after env vars are patched.
    from app.config import get_settings
    get_settings.cache_clear()
    from app.main import create_app
    return TestClient(create_app())


def test_inbound_returns_xml():
    client = _make_client()
    resp = client.post(
        "/voice/twilio/inbound",
        data={
            "CallSid": "CA123",
            "From": "+15550001111",
            "To": "+15550002222",
        },
    )
    assert resp.status_code == 200
    assert "application/xml" in resp.headers["content-type"]
    assert "<ConversationRelay" in resp.text


def test_inbound_twiml_has_wss_url():
    client = _make_client()
    resp = client.post(
        "/voice/twilio/inbound",
        data={
            "CallSid": "CA456",
            "From": "+15550001111",
            "To": "+15550002222",
        },
    )
    assert "wss://test.example.com/voice/twilio/ws" in resp.text


def test_inbound_includes_call_sid_parameter():
    client = _make_client()
    resp = client.post(
        "/voice/twilio/inbound",
        data={
            "CallSid": "CA789",
            "From": "+15550001111",
            "To": "+15550002222",
        },
    )
    assert "CA789" in resp.text


def test_inbound_welcome_greeting_present():
    client = _make_client()
    resp = client.post(
        "/voice/twilio/inbound",
        data={
            "CallSid": "CA000",
            "From": "+15550001111",
            "To": "+15550002222",
        },
    )
    assert "welcomeGreeting" in resp.text


def test_health_endpoint():
    client = _make_client()
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True, (
        f"health degraded: redis={data.get('redis_status')} "
        f"identity_failures={data.get('runtime_identity_failures')}"
    )
    assert data["runtime"] == "twilio_conversation_relay"
