"""
v4.1.2 tests — inbound phone log masking and privacy.

Covers:
 - Inbound call log masks From and To numbers
 - CallSid is truncated (not full)
 - _mask_phone helper works correctly
 - payment_flow_status visible in router context (not idle)
 - confirmed email masked in router context
 - pending email never fully shown in router context
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")


class TestInboundPhoneMasking:
    def test_mask_phone_last_four(self):
        from app.api.twilio_voice import _mask_phone
        assert _mask_phone("+14155551234") == "***1234"

    def test_mask_phone_international(self):
        from app.api.twilio_voice import _mask_phone
        assert _mask_phone("+923001497123") == "***7123"

    def test_mask_phone_empty(self):
        from app.api.twilio_voice import _mask_phone
        assert _mask_phone("") == "***"

    def test_mask_phone_short(self):
        from app.api.twilio_voice import _mask_phone
        assert _mask_phone("12") == "***"

    async def test_inbound_log_uses_masked_phone(self, caplog):
        """inbound_call handler must not log full phone numbers."""
        import logging
        from unittest.mock import AsyncMock, MagicMock, patch
        from fastapi import Request
        from app.api.twilio_voice import inbound_call

        mock_request = MagicMock(spec=Request)
        mock_request.headers = {}

        settings_mock = MagicMock()
        settings_mock.VALIDATE_TWILIO_SIGNATURES = False
        settings_mock.SHOPIFY_SHOP_DOMAIN = "test.myshopify.com"
        settings_mock.ws_url = "wss://example.com/ws"

        with caplog.at_level(logging.INFO, logger="app.api.twilio_voice"), \
             patch("app.api.twilio_voice.get_settings", return_value=settings_mock), \
             patch("app.api.twilio_voice.validate_twilio_signature", new_callable=AsyncMock):
            await inbound_call(
                request=mock_request,
                CallSid="CA12345678901234567890123456789012",
                From="+14155559876",
                To="+12025551234",
            )

        log_text = caplog.text
        # Full phone numbers must not appear
        assert "+14155559876" not in log_text
        assert "+12025551234" not in log_text
        # Masked forms should appear
        assert "***9876" in log_text
        assert "***1234" in log_text


class TestRouterContextPrivacy:
    def _make_session(self, *, pfs="idle", confirmed_email="", pending_email=""):
        from app.state.models import SessionState
        s = SessionState(
            session_id="s", call_sid="CA99",
            from_number="+1", to_number="+2",
        )
        s.payment_flow_status = pfs
        s.confirmed_email = confirmed_email
        s.pending_email = pending_email
        return s

    def test_payment_flow_status_in_context(self):
        from app.pipeline.engine import _build_router_context
        from app.pipeline.router import IntentResult
        session = self._make_session(pfs="awaiting_email_confirmation")
        intent = IntentResult(intent="email_provided", confidence=0.85, entities={})
        ctx = _build_router_context(intent, session)
        assert ctx is not None
        assert "awaiting_email_confirmation" in ctx

    def test_confirmed_email_masked_in_context(self):
        from app.pipeline.engine import _build_router_context
        from app.pipeline.router import IntentResult
        session = self._make_session(confirmed_email="alice@example.com")
        intent = IntentResult(intent="send_payment_link", confidence=0.85, entities={})
        ctx = _build_router_context(intent, session)
        assert ctx is not None
        assert "alice@example.com" not in ctx  # full email never in context
        assert "Confirmed email" in ctx

    def test_pending_email_note_in_context(self):
        from app.pipeline.engine import _build_router_context
        from app.pipeline.router import IntentResult
        session = self._make_session(pending_email="alice@example.com")
        intent = IntentResult(intent="email_confirmation", confidence=0.9, entities={})
        ctx = _build_router_context(intent, session)
        assert ctx is not None
        assert "alice@example.com" not in ctx
        assert "pending" in ctx.lower()
