"""
v4.28 — Payment link send hardening after email confirm.

- Stronger email capture (fragments, Hinglish yes, international domains)
- Deferred auto-send when confirm stuck without send
- Email request script with facility/inmate line
- Resend retry path after failed send
"""
from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("RESEND_API_KEY", "re_test")
os.environ.setdefault("RESEND_FROM_EMAIL", "orders@example.com")

from app.agent_runtime.llm_tool_runtime import LLMToolRuntime
from app.cart.session import add_product_candidate, confirm_last_candidate
from app.payment.email_state import (
    confirm_payment_email,
    get_canonical_confirmed_email,
    set_pending_payment_email,
)
from app.payment.payment_prompts import PAYMENT_EMAIL_REQUEST_LINE
from app.payment.payment_state_machine import (
    extract_email_from_text,
    needs_deferred_payment_auto_send,
    process_payment_turn,
)
from app.pipeline.email_capture import is_email_confirmation, normalize_spoken_email
from app.state.models import SessionState

EMAIL = "buyer@yahoo.co.in"


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="v428",
        call_sid="CA_V428001",
        from_number="+15551230000",
        to_number="+15559999999",
        **kwargs,
    )


def _cart_ready(session: SessionState) -> None:
    add_product_candidate(
        session,
        title="Test Book",
        isbn="9780000000010",
        variant_id="gid://shopify/ProductVariant/10",
        price="12.00",
    )
    confirm_last_candidate(session)
    session.payment_flow_status = "awaiting_email"
    session.payment_cart_confirmed = True


class TestEmailCaptureStrength:
    def test_international_domain_yahoo_co_in(self):
        spoken = "buyer at yahoo dot co dot in"
        assert normalize_spoken_email(spoken) == EMAIL

    def test_hinglish_confirmation_haan(self):
        assert is_email_confirmation("haan")

    def test_hinglish_confirmation_theek_hai(self):
        assert is_email_confirmation("theek hai")

    def test_email_fragments_assembled(self):
        session = _session()
        session.pending_email_fragments = ["buyer at yahoo"]
        assert extract_email_from_text("dot co dot in", session) == EMAIL

    def test_email_request_line_mentions_facility(self):
        assert "facility" in PAYMENT_EMAIL_REQUEST_LINE.lower()
        assert "payment link" in PAYMENT_EMAIL_REQUEST_LINE.lower()


class TestConfirmAndAutoSend:
    def test_yes_after_capture_confirms_and_flags_send(self):
        session = _session()
        _cart_ready(session)
        cap = process_payment_turn(session, f"My email is {EMAIL}")
        assert cap.force_reply
        assert cap.email_captured

        confirm = process_payment_turn(session, "haan")
        assert confirm.email_confirmed
        assert get_canonical_confirmed_email(session) == EMAIL

    @pytest.mark.asyncio
    async def test_auto_send_after_confirm_calls_send_payment_link(self):
        session = _session()
        _cart_ready(session)
        set_pending_payment_email(session, EMAIL)
        confirm_payment_email(session)

        send_fn = AsyncMock()
        runtime = LLMToolRuntime()

        ok_payload = json.dumps({
            "success": True,
            "email_sent": True,
            "customer_message": "I sent the secure payment link to your email.",
        })

        with patch("app.agent_runtime.llm_tools.dispatch", new_callable=AsyncMock) as mock_dispatch:
            mock_dispatch.return_value = ok_payload
            await runtime.handle_turn(session, "yes that's correct", send_fn)

        mock_dispatch.assert_called_once()
        assert mock_dispatch.call_args[0][0] == "send_payment_link"
        assert session.payment_email_confirmed

    def test_deferred_auto_send_when_confirmed_but_not_sent(self):
        session = _session()
        _cart_ready(session)
        set_pending_payment_email(session, EMAIL)
        confirm_payment_email(session)
        session.payment_link_sent = False
        session.payment_flow_status = "awaiting_send_confirmation"
        assert needs_deferred_payment_auto_send(session)


class TestSendRetry:
    @pytest.mark.asyncio
    async def test_send_retries_once_on_email_failure(self):
        from app.payment.payment_link_service import send_confirmed_payment_link

        session = _session()
        _cart_ready(session)
        set_pending_payment_email(session, EMAIL)
        confirm_payment_email(session)

        fail = json.dumps({"success": False, "email_sent": False, "error_code": "email_send_failed"})
        ok = json.dumps({"success": True, "email_sent": True, "customer_message": "sent"})

        with patch(
            "app.tools.shopify_tools.SendPaymentLink",
            new_callable=AsyncMock,
            side_effect=[fail, ok],
        ):
            result = await send_confirmed_payment_link(session)

        assert result.get("success")
        assert result.get("email_sent")
