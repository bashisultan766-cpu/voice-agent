"""End-to-end email capture, letter-by-letter readback, confirm, and send (v4.53)."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent_runtime.not_found_escalation_flow import process_not_found_escalation_turn
from app.agents.main_commerce_brain import MainCommerceBrain
from app.config import Settings
from app.email.capture import is_email_confirmation, normalize_spoken_email
from app.email.resolver import resolve_spoken_email_address
from app.email.speller import is_preserved_email_readback, spell_email_letter_by_letter
from app.payment.email_state import get_canonical_confirmed_email
from app.payment.payment_state_machine import (
    capture_payment_email,
    process_payment_turn,
    speak_confirmation_prompt,
)
from app.state.models import SessionState


EMAIL = "mubashirbusiness3@gmail.com"
SPELLED = "M U B A S H I R B u s i n e s s three at gmail dot com"


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="sess_v451",
        call_sid="CAv45101",
        from_number="+15551234001",
        to_number="+15559994001",
        cart_items=[{"title": "Book", "variant_id": "v1", "quantity": 1}],
        payment_flow_status="awaiting_email",
        awaiting_payment_email=True,
    )
    base.update(kwargs)
    return SessionState(**base)


class TestEmailCaptureVariants:
    def test_spelled_mubashir_email(self):
        assert normalize_spoken_email(SPELLED) == EMAIL
        assert resolve_spoken_email_address(SPELLED).email == EMAIL

    def test_typed_email(self):
        assert normalize_spoken_email("buyer@yahoo.com") == "buyer@yahoo.com"

    def test_hyphen_domain_email(self):
        text = "john dot smith at outlook dot com"
        assert normalize_spoken_email(text) == "john.smith@outlook.com"

    def test_digit_words_email(self):
        text = "alice seven six six at gmail dot com"
        assert normalize_spoken_email(text) == "alice766@gmail.com"

    def test_readback_matches_stored_chars(self):
        spelled = spell_email_letter_by_letter(EMAIL)
        assert "M. U. B. A. S. H. I. R" in spelled
        assert "three" in spelled
        assert "G. M. A. I. L" in spelled
        assert "-" not in spelled


class TestPaymentEmailFlow:
    def test_capture_then_readback_prompt(self):
        session = _session()
        hint = process_payment_turn(session, SPELLED, turn_mode="email")
        assert hint.email_captured
        assert session.pending_payment_email == EMAIL
        assert "letter by letter" in hint.force_reply
        assert spell_email_letter_by_letter(EMAIL) in hint.force_reply

    def test_confirm_then_ready_for_send(self):
        session = _session()
        capture_payment_email(session, EMAIL)
        hint = process_payment_turn(session, "that's true")
        assert hint.email_confirmed or get_canonical_confirmed_email(session) == EMAIL
        assert session.payment_email_confirmed
        assert session.payment_flow_status == "awaiting_send_confirmation"

    def test_finalize_preserves_full_readback(self):
        brain = MainCommerceBrain(settings=Settings())
        session = _session()
        prompt = speak_confirmation_prompt(EMAIL)
        assert is_preserved_email_readback(prompt)
        out = brain.finalize_response(session, prompt, [])
        assert spell_email_letter_by_letter(EMAIL) in out
        assert "three" in out


class TestSupportHandoffEmailFlow:
    @pytest.mark.asyncio
    async def test_support_capture_readback_and_confirm(self):
        session = _session(
            awaiting_not_found_escalation_email=True,
            payment_flow_status="idle",
            awaiting_payment_email=False,
            pending_not_found_escalation={
                "session_id": "sess_v451",
                "call_sid": "CAv45101",
                "query_type": "product",
                "issue_title": "Not found",
                "issue_detail": "No match",
                "customer_name": "Ali",
            },
        )
        hint1 = await process_not_found_escalation_turn(session, SPELLED)
        assert hint1.force_reply
        assert "letter by letter" in hint1.force_reply
        assert spell_email_letter_by_letter(EMAIL) in hint1.force_reply

        pending = session.pending_not_found_escalation
        assert pending.get("awaiting_email_confirmation")
        assert pending.get("staging_email") == EMAIL

        assert is_email_confirmation("that's true")

        mock_client = AsyncMock()
        mock_resp = MagicMock(status_code=200)
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        settings = Settings(
            SUPPORT_EMAIL="support@test.com",
            RESEND_API_KEY="re_test",
            SUPPORT_ESCALATION_ENABLED=True,
        )

        with patch("app.escalation.support_handoff.get_settings", return_value=settings):
            with patch("app.escalation.support_handoff.httpx.AsyncClient", return_value=mock_client):
                with patch(
                    "app.escalation.conversation_summarizer.summarize_conversation_for_support",
                    new_callable=AsyncMock,
                    return_value=("- Customer wants the book.\n- Not in catalog.", ""),
                ):
                    hint2 = await process_not_found_escalation_turn(session, "that's true")

        assert hint2.force_reply
        assert "support team" in hint2.force_reply.lower()
        body = mock_client.post.call_args.kwargs["json"]["text"]
        assert f"Email: {EMAIL}" in body
        assert "Conversation:" in body
        assert session.awaiting_not_found_escalation_email is False

    def test_support_handoff_thats_true_confirms(self):
        from app.agent_runtime.not_found_escalation_flow import _is_email_confirmation

        assert _is_email_confirmation("that's true")
        assert _is_email_confirmation("Yeah. That's correct email.")
        assert not _is_email_confirmation("Yes. My name is Bashi Sultan.")
