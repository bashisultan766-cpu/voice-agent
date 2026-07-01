"""Regression tests from live call CAc965 — email readback and handoff."""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.agent_runtime.not_found_escalation_flow import (
    _email_ready_to_confirm,
    _is_email_confirmation,
    process_not_found_escalation_turn,
)
from app.config import Settings
from app.config import Settings
from app.dialogue.anti_silence import anti_silence_reply
from app.email.capture import (
    email_capture_turn_active,
    is_email_confirmation,
    is_email_correction,
    is_supplying_email_address,
    normalize_spoken_email,
)
from app.email.speller import build_email_readback_parts, spell_email_letter_by_letter
from app.payment.payment_state_machine import process_payment_turn
from app.state.models import SessionState


def test_my_correct_email_is_not_confirmation():
    text = "My correct email is bashi 6 4 at g mail dot com"
    assert is_supplying_email_address(text)
    assert not is_email_confirmation(text)
    assert not _is_email_confirmation(text)


def test_thats_not_correct_is_correction_not_confirmation():
    assert is_email_correction("That's not correct.")
    assert is_email_correction("No. It's not correct.")
    assert not is_email_confirmation("That's not correct.")


def test_fragment_64_gmail_not_ready():
    email = normalize_spoken_email("6 4 activate g mail dot com")
    assert email == "64@gmail.com"
    assert not _email_ready_to_confirm(email, "6 4 activate g mail dot com")


def test_bashi64_gmail_ready():
    email = normalize_spoken_email("bashi 6 4 at g mail dot com")
    assert email == "bashi64@gmail.com"
    assert _email_ready_to_confirm(email, "bashi 6 4 at g mail dot com")


def test_spell_uses_period_pacing():
    spelled = spell_email_letter_by_letter("bashi64@gmail.com")
    assert "B. A. S. H. I" in spelled or "B. A." in spelled
    assert ". At." in spelled
    assert "," not in spelled


def test_readback_split_into_chunks():
    parts = build_email_readback_parts("bashi64@gmail.com")
    assert len(parts) >= 5
    assert parts[0].startswith("I have ")
    assert parts[1] == "I will spell it for confirmation."
    assert parts[-1] == "Is that correct?"
    assert any("-" in p for p in parts)


def test_anti_silence_skips_email_correction():
    session = SessionState(
        session_id="s",
        call_sid="CAc965",
        from_number="+1",
        to_number="+2",
        awaiting_payment_email_confirmation=True,
        pending_payment_email="bashi64@gmail.com",
        payment_flow_status="awaiting_email_confirmation",
    )
    assert email_capture_turn_active(session)
    assert anti_silence_reply(session, "That's not correct.") is None


def test_payment_correction_after_reject():
    session = SessionState(
        session_id="s",
        call_sid="CAc965",
        from_number="+1",
        to_number="+2",
        cart_items=[{"title": "Book", "variant_id": "v1", "quantity": 1}],
        awaiting_payment_email_confirmation=True,
        pending_payment_email="wrong@yahoo.com",
        payment_flow_status="awaiting_email_confirmation",
    )
    hint = process_payment_turn(session, "That's not correct.")
    assert hint.force_reply
    assert "correct email" in hint.force_reply.lower()
    assert not session.pending_payment_email


@pytest.mark.asyncio
async def test_support_handoff_sends_silently_after_email():
    session = SessionState(
        session_id="s",
        call_sid="CAc965",
        from_number="+1",
        to_number="+2",
        awaiting_not_found_escalation_email=True,
        pending_not_found_escalation={
            "session_id": "s",
            "call_sid": "CAc965",
            "query_type": "title",
            "issue_title": "Not found",
            "issue_detail": "No catalog match.",
            "customer_name": "Han",
            "email_capture_mode": "silent",
        },
    )
    mock_resp = MagicMock(status_code=200)
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("app.escalation.support_handoff.get_settings") as mock_settings:
        mock_settings.return_value = Settings(
            SUPPORT_EMAIL="support@test.com",
            RESEND_API_KEY="re_test",
            SUPPORT_ESCALATION_FROM_EMAIL="Voice Agent <noreply@test.com>",
            SUPPORT_ESCALATION_ENABLED=True,
        )
        with patch("app.escalation.support_handoff.httpx.AsyncClient", return_value=mock_client):
            with patch(
                "app.escalation.conversation_summarizer.analyze_conversation_for_support",
                new_callable=AsyncMock,
                return_value=({"issue_summary": "Not found", "user_intent": "title", "unresolved_needs": "x", "urgency_level": "medium"}, ""),
            ):
                hint = await process_not_found_escalation_turn(
                    session,
                    "My correct email is bashi 6 4 at g mail dot com",
                )

    assert hint.force_reply
    assert "letter by letter" not in hint.force_reply.lower()
    assert session.pending_not_found_escalation.get("awaiting_email_confirmation") is not True
    assert session.caller_email == "bashi64@gmail.com"
    assert mock_client.post.await_count == 1
