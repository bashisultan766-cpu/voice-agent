"""Live-call UX fixes — greeting, yes, multi-book cart, email, call closure."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from app.cart.ledger import CartItem, CartLedger
from app.dialogue.call_closure import process_call_closure_turn
from app.dialogue.greeting import build_twiml_greeting, greeting_safe_name
from app.email.deliverability import build_payment_email_bodies
from app.payment.drop_shipping_fee import checkout_email_lines
from app.runtime.fast_classifier import classify
from app.runtime.voice_commerce_runtime import VoiceCommerceRuntime
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="s1",
        call_sid="CA_LIVE_UX_001",
        from_number="+15551234567",
        to_number="+15559876543",
    )
    base.update(kwargs)
    return SessionState(**base)


class TestGreetingSafeName:
    def test_rejects_saying_that_stt_garbage(self):
        assert greeting_safe_name("saying that?") == ""
        assert greeting_safe_name("Saying that") == ""
        assert greeting_safe_name("saying") == ""

    def test_twiml_new_caller_greeting(self):
        text = build_twiml_greeting(returning=False)
        assert "This is SureShot Books" in text
        assert "saying that" not in text.lower()

    def test_twiml_returning_filters_bad_name(self):
        text = build_twiml_greeting(returning=True, caller_name="saying that?")
        assert "saying that" not in text.lower()
        assert "SureShot Books" in text


class TestMultiBookCart:
    def test_two_different_books_stay_separate(self):
        ledger = CartLedger()
        ledger.add_candidate(
            CartItem(title="Book A", isbn="9780000000001", variant_id="v1", quantity=2)
        )
        ledger.confirm_last_candidate()
        ledger.add_candidate(
            CartItem(title="Book B", isbn="9780000000002", variant_id="v2", quantity=1)
        )
        ledger.confirm_last_candidate()
        confirmed = ledger.confirmed_items
        assert len(confirmed) == 2
        assert confirmed[0].quantity == 2
        assert confirmed[1].quantity == 1


class TestPaymentEmailBreakdown:
    def test_email_shows_subtotal_fee_and_line_totals(self):
        lines = checkout_email_lines(
            [
                {"title": "Book A", "quantity": 2, "price": "10.00", "variant_id": "v1"},
                {"title": "Book B", "quantity": 1, "price": "8.50", "variant_id": "v2"},
            ]
        )
        _, plain, html = build_payment_email_bodies("https://pay.example.com/x", order_lines=lines)
        assert "Book A" in html
        assert "Book B" in html
        assert "Books subtotal" in html
        assert "Drop Shipping Fee" in html
        assert "Order total (before shipping)" in html
        assert "2 cop" in plain or "2 copy" in plain


class TestCallClosure:
    def test_no_after_anything_else_ends_call(self):
        session = _session(awaiting_anything_else=True)
        result = process_call_closure_turn(session, "no")
        assert result is not None
        assert result.end_call is True
        assert "Goodbye" in result.reply or "goodbye" in result.reply.lower()


class TestYesEngagementInVoiceRuntime:
    @pytest.mark.asyncio
    async def test_bare_yes_during_quantity_gets_prompt(self):
        session = _session(
            commerce_flow_status="awaiting_quantity",
            commerce_pending_candidate={
                "title": "Atomic Habits",
                "variant_id": "v99",
                "price": "12.00",
            },
        )
        sent: list[dict] = []

        async def send(msg):
            sent.append(msg)

        runtime = VoiceCommerceRuntime()
        with patch("app.config.get_settings") as mock_settings:
            mock_settings.return_value.OPENAI_API_KEY = "sk-test"
            with patch.object(runtime._brain, "finalize_response", side_effect=lambda s, t, tr: t):
                result = await runtime.handle_turn(session, "yes", send)

        assert "cop" in result.response_text.lower() or "add" in result.response_text.lower()
        assert any(m.get("token") for m in sent if m.get("type") == "text")


class TestNoRoboticAck:
    def test_product_search_skips_ack(self):
        session = _session()
        result = classify("I need the book Atomic Habits", session)
        assert result.action == "brain"
        assert not result.ack_reply
