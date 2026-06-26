"""
Tests for the ConversationRelay WebSocket message handling.

Uses synchronous mocks to avoid live API calls.
"""
from __future__ import annotations

import asyncio
import json
import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("VALIDATE_TWILIO_SIGNATURES", "false")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")


from app.state.models import SessionState


def _make_session(call_sid: str = "CA_TEST") -> SessionState:
    return SessionState(
        session_id="sess-001",
        call_sid=call_sid,
        from_number="+15550001111",
        to_number="+15550002222",
    )


# ── SessionState unit tests ───────────────────────────────────────────────────

def test_session_state_defaults():
    s = _make_session()
    assert s.turn_count == 0
    assert s.history == []
    assert s.agent_id == ""


def test_session_state_history_mutation():
    s = _make_session()
    s.history.append({"role": "user", "content": "hello"})
    s.turn_count += 1
    assert len(s.history) == 1
    assert s.turn_count == 1


# ── system_prompt unit tests ──────────────────────────────────────────────────

def test_build_system_message_role():
    from app.ai.system_prompt import build_system_message
    msg = build_system_message()
    assert msg["role"] == "system"
    # v4.1: prompt says "SureShot Books" and mentions books/incarcerated context
    assert "books" in msg["content"].lower()
    assert "eric" in msg["content"].lower()


def test_build_system_message_includes_agent_name():
    from app.ai.system_prompt import build_system_message
    msg = build_system_message(agent_name="Sam")
    assert "Sam" in msg["content"]


def test_build_system_message_includes_store_domain():
    from app.ai.system_prompt import build_system_message
    msg = build_system_message(store_domain="books.myshopify.com")
    assert "books.myshopify.com" in msg["content"]


# ── tool_schemas unit tests ───────────────────────────────────────────────────

def test_tool_schemas_count():
    from app.ai.tool_schemas import TOOL_SCHEMAS
    # v4.2: 12 ElevenLabs-aligned tools + 3 legacy aliases = 15
    assert len(TOOL_SCHEMAS) == 15


def test_tool_schemas_names():
    from app.ai.tool_schemas import TOOL_SCHEMAS
    names = {t["function"]["name"] for t in TOOL_SCHEMAS}
    # ElevenLabs-aligned primary tools
    assert "GetOrder" in names
    assert "SureShotCatalogSearch" in names
    assert "CalculatePricing" in names
    assert "CheckFacilityApproval" in names
    assert "CheckOrderFacilityRestrictions" in names
    assert "AddressUpdateInstructions" in names
    assert "CancelOrderRequest" in names
    assert "EscalateToCustomerService" in names
    assert "SendFacilityPaymentLink" in names
    assert "SendPaymentLink" in names
    assert "GetCallerInfo" in names
    assert "SaveCallerName" in names
    # Legacy aliases
    assert "SureShotBooksSku" in names
    assert "SureShotBooksProductFetcher" in names
    assert "SureShotBooksProduct" in names


def test_tool_schemas_have_descriptions():
    from app.ai.tool_schemas import TOOL_SCHEMAS
    for tool in TOOL_SCHEMAS:
        fn = tool["function"]
        assert fn.get("description"), f"Tool {fn['name']} missing description"


# ── ConversationRelay WS message format tests ─────────────────────────────────

def test_text_token_message_format():
    """Verify the expected JSON structure for streaming text tokens."""
    msg = {"type": "text", "token": "Hello", "last": False, "interruptible": True}
    assert msg["type"] == "text"
    assert "last" in msg
    assert "interruptible" in msg


def test_final_message_format():
    msg = {"type": "text", "token": "", "last": True}
    assert msg["last"] is True
    assert msg["token"] == ""


# ── Registry dispatch tests ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_registry_unknown_tool_returns_error_json():
    from app.tools import registry
    session = _make_session()
    result = await registry.dispatch("nonexistent_tool", {}, session)
    data = json.loads(result)
    assert "error" in data


@pytest.mark.asyncio
async def test_registry_injects_caller_phone_for_escalation():
    """escalate_to_human should receive the session phone even if LLM omits it."""
    import app.tools.registry as reg_module

    captured = {}

    async def fake_escalate(**kwargs):
        captured.update(kwargs)
        return json.dumps({"escalated": True, "message": "ok"})

    # Patch the entry in _TOOL_MAP directly (the dict holds function references
    # captured at import time; patching _st.* has no effect after that).
    original = reg_module._TOOL_MAP["escalate_to_human"]
    reg_module._TOOL_MAP["escalate_to_human"] = fake_escalate
    try:
        session = _make_session("CA_ESC")
        session.from_number = "+15551234567"
        await reg_module.dispatch("escalate_to_human", {"reason": "test"}, session)
        assert captured.get("caller_phone") == "+15551234567"
    finally:
        reg_module._TOOL_MAP["escalate_to_human"] = original


# ── Config / env validation tests ─────────────────────────────────────────────

def test_settings_ws_url_derives_from_public_base():
    from app.config import get_settings, Settings
    s = Settings(PUBLIC_BASE_URL="https://voice.example.com", OPENAI_API_KEY="x", DEBUG=True)
    assert s.ws_url == "wss://voice.example.com/voice/twilio/ws"


def test_settings_validate_production_passes_with_all_keys():
    from app.config import Settings
    s = Settings(
        OPENAI_API_KEY="sk-test",
        TWILIO_ACCOUNT_SID="AC123",
        TWILIO_AUTH_TOKEN="auth-tok",
        ENABLE_ELEVENLABS=False,
        ENABLE_DEEPGRAM=False,
        DEBUG=False,
    )
    s.validate_production()  # must not raise


def test_settings_validate_production_fails_missing_key():
    from app.config import Settings
    s = Settings(OPENAI_API_KEY="", DEBUG=False)
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        s.validate_production()


def test_settings_validate_production_fails_if_elevenlabs_enabled():
    from app.config import Settings
    s = Settings(
        OPENAI_API_KEY="sk-test",
        TWILIO_ACCOUNT_SID="AC123",
        TWILIO_AUTH_TOKEN="tok",
        ENABLE_ELEVENLABS=True,
        DEBUG=False,
    )
    with pytest.raises(RuntimeError, match="ENABLE_ELEVENLABS"):
        s.validate_production()
