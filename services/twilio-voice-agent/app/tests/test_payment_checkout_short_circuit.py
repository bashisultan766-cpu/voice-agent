"""Deterministic payment checkout short-circuit — session cart + Shopify tool only."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.agent_runtime.payment_flow_state import (
    PAYMENT_LINK_DUPLICATE_MESSAGE,
    PAYMENT_LINK_VOICE_TEMPLATE,
    build_session_checkout_invoice,
    checkout_payment_intent_detected,
    try_payment_checkout_short_circuit,
)
from app.cart.session import add_product_candidate, confirm_last_candidate
from app.runtime.voice_commerce_runtime import VoiceCommerceRuntime
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="pay-sc",
        call_sid="CApaysc123",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


def _confirm_book(session: SessionState) -> None:
    add_product_candidate(
        session,
        title="Atomic Habits",
        isbn="9780747532699",
        variant_id="v1",
        price="12.00",
        quantity=2,
    )
    confirm_last_candidate(session)


def test_checkout_intent_detected():
    assert checkout_payment_intent_detected("I'm ready for checkout")
    assert checkout_payment_intent_detected("send payment please")
    assert not checkout_payment_intent_detected("order status")


def test_build_session_checkout_invoice_from_cart():
    session = _session()
    _confirm_book(session)
    session.payment_cart_confirmed = True
    invoice = build_session_checkout_invoice(session)
    assert len(invoice["items"]) == 1
    assert invoice["items"][0]["variant_id"] == "v1"
    assert invoice["items"][0]["quantity"] == 2
    assert invoice["total_copies"] == 2
    assert invoice["total_price"] == 24.0


def test_checkout_blocked_without_cart_confirmed():
    session = _session()
    hint = try_payment_checkout_short_circuit(session, "checkout please")
    assert hint is not None
    assert hint.openai_skipped
    assert not hint.send_payment_link
    assert "confirm" in hint.force_reply.lower()


def test_checkout_prompts_for_email_when_cart_ready():
    session = _session(payment_cart_confirmed=True)
    _confirm_book(session)
    hint = try_payment_checkout_short_circuit(session, "checkout")
    assert hint is not None
    assert hint.openai_skipped
    assert not hint.send_payment_link
    assert "email" in hint.force_reply.lower()


def test_checkout_duplicate_blocked():
    session = _session(payment_cart_confirmed=True, payment_link_sent=True)
    _confirm_book(session)
    session.payment_email_confirmed = True
    session.confirmed_email = "buyer@example.com"
    hint = try_payment_checkout_short_circuit(session, "payment")
    assert hint is not None
    assert hint.blocked_duplicate
    assert hint.force_reply == PAYMENT_LINK_DUPLICATE_MESSAGE


def test_checkout_ready_to_send():
    session = _session(
        payment_cart_confirmed=True,
        payment_email_confirmed=True,
        confirmed_email="buyer@example.com",
        email_verified=True,
    )
    _confirm_book(session)
    hint = try_payment_checkout_short_circuit(session, "checkout")
    assert hint is not None
    assert hint.send_payment_link
    assert hint.force_reply == PAYMENT_LINK_VOICE_TEMPLATE
    assert len(hint.checkout_items) == 1


@pytest.mark.asyncio
async def test_runtime_checkout_short_circuit_sends_once():
    session = _session(
        payment_cart_confirmed=True,
        payment_email_confirmed=True,
        confirmed_email="buyer@example.com",
        email_verified=True,
    )
    _confirm_book(session)
    runtime = VoiceCommerceRuntime()
    spoken_parts: list[str] = []

    async def send(msg: dict) -> None:
        if msg.get("token"):
            spoken_parts.append(msg["token"])

    with patch(
        "app.payment.payment_link_service.send_confirmed_payment_link",
        new_callable=AsyncMock,
    ) as mock_send:
        mock_send.return_value = {
            "success": True,
            "email_sent": True,
            "customer_message": "ignored",
        }
        result = await runtime._handle_payment_checkout_short_circuit(
            session,
            "checkout",
            send,
            sid="CApays",
        )

    assert result is not None
    assert mock_send.call_count == 1
    assert mock_send.call_args.kwargs["items"][0]["variant_id"] == "v1"
    assert "secure Shopify payment link" in " ".join(spoken_parts)
