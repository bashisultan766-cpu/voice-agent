"""
v4.23 — Live payment/email short-circuit regressions.

Reproduces the latest production failure: two books in cart, caller gives email,
LLM must NOT run and create_checkout must NOT be called on that turn.
"""
from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.agent_runtime import llm_tools
from app.agent_runtime.llm_tool_runtime import LLMToolRuntime
from app.agent_runtime.payment_flow_state import (
    PAYMENT_SUCCESS_MESSAGE,
    confirmation_prompt,
    process_payment_turn,
)
from app.agent_runtime.tool_runtime_gates import gate_tool_call
from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
from app.payment.email_state import (
    get_canonical_confirmed_email,
    get_pending_payment_email,
)
from app.email.speller import speak_email, spell_email_for_voice
from app.state.models import SessionState


LIVE_EMAIL_UTTERANCE = (
    "Okay. My email address is bashisultan766@gmail.com."
)
LIVE_EMAIL = "bashisultan766@gmail.com"


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="v423",
        call_sid="CA_V423_LIVE",
        from_number="+15551230000",
        to_number="+15559999999",
        **kwargs,
    )


def _two_books_in_cart(session: SessionState) -> None:
    for i in range(2):
        add_product_candidate(
            session,
            title=f"Live Book {i + 1}",
            isbn=f"97800000010{i}",
            variant_id=f"gid://shopify/ProductVariant/live{i + 1}",
            price="12.00",
        )
        confirm_last_candidate(session)
    session.payment_flow_status = "awaiting_email"
    session.payment_cart_confirmed = True


class TestLiveEmailTurnShortCircuit:
    """Exact latest live call — email turn must not reach OpenAI."""

    def test_process_payment_turn_sets_pending(self):
        session = _session()
        _two_books_in_cart(session)
        hint = process_payment_turn(
            session, LIVE_EMAIL_UTTERANCE, turn_mode="email",
        )
        assert hint.force_reply
        assert speak_email(LIVE_EMAIL) in hint.force_reply
        assert spell_email_for_voice(LIVE_EMAIL) in hint.force_reply
        assert "Is that correct?" in hint.force_reply
        assert get_pending_payment_email(session) == LIVE_EMAIL
        assert session.awaiting_payment_email_confirmation is True
        assert session.payment_email_confirmed is False
        assert session.confirmed_email == ""

    @pytest.mark.asyncio
    async def test_handle_turn_skips_openai_and_tools(self):
        runtime = LLMToolRuntime()
        session = _session()
        _two_books_in_cart(session)

        openai_calls: list[dict] = []

        async def fake_complete(messages, sid):
            openai_calls.append({"messages": messages, "sid": sid})
            raise AssertionError("OpenAI must not be called on email capture turn")

        checkout_calls: list[str] = []

        async def fake_dispatch(name, args, session):
            checkout_calls.append(name)
            return json.dumps({"success": False})

        sent: list[dict] = []

        async def send(msg):
            sent.append(msg)

        with patch.object(runtime, "_complete", side_effect=fake_complete):
            with patch.object(llm_tools, "dispatch", side_effect=fake_dispatch):
                result = await runtime.handle_turn(
                    session,
                    LIVE_EMAIL_UTTERANCE,
                    send,
                    assembled_turn_mode="email",
                )

        assert not openai_calls
        assert "create_checkout" not in checkout_calls
        assert "send_payment_link" not in checkout_calls
        assert speak_email(LIVE_EMAIL) in result.response_text
        assert spell_email_for_voice(LIVE_EMAIL) in result.response_text
        assert "correct" in result.response_text.lower()
        assert not [m for m in session.history if m.get("role") == "tool"]

    def test_create_checkout_not_llm_facing(self):
        exposed = {s["function"]["name"] for s in llm_tools.tool_specs()}
        assert "create_checkout" not in exposed
        assert "send_payment_link" in exposed


class TestCreateCheckoutGatedBeforeConfirm:
    @pytest.mark.asyncio
    async def test_dispatch_blocks_without_shopify_call(self, monkeypatch):
        session = _session()
        _two_books_in_cart(session)
        session.pending_payment_email = LIVE_EMAIL
        session.awaiting_payment_email_confirmation = True

        shopify_called = {"n": 0}

        async def fake_checkout(*_a, **_k):
            shopify_called["n"] += 1
            return json.dumps({"success": True})

        monkeypatch.setattr(llm_tools._st, "create_checkout_link", fake_checkout)

        gate = gate_tool_call("create_checkout", session)
        assert gate is not None and not gate.allowed
        assert gate.reason == "email_unconfirmed"

        out = await llm_tools.dispatch("create_checkout", {}, session)
        data = json.loads(out)
        assert data["success"] is False
        assert data.get("error_code") == "email_unconfirmed"
        assert shopify_called["n"] == 0
        assert "confirm" in data["customer_message"].lower() or LIVE_EMAIL in data["customer_message"]


class TestFullPaymentFlowTwoBooks:
    @pytest.mark.asyncio
    async def test_email_confirm_auto_send_one_checkout(self, monkeypatch):
        runtime = LLMToolRuntime()
        session = _session()
        _two_books_in_cart(session)

        sent: list[dict] = []

        async def send(msg):
            sent.append(msg)

        result = await runtime.handle_turn(
            session,
            LIVE_EMAIL_UTTERANCE,
            send,
            assembled_turn_mode="email",
        )
        assert speak_email(LIVE_EMAIL) in result.response_text
        assert spell_email_for_voice(LIVE_EMAIL) in result.response_text
        assert session.awaiting_payment_email_confirmation is True

        checkout_calls: list[dict] = []
        email_sends = {"n": 0}

        async def fake_send_payment(items, email="", customer_name=None, session=None):
            checkout_calls.append({"items": items, "email": email})
            email_sends["n"] += 1
            return json.dumps({
                "success": True,
                "email_sent": True,
                "customer_message": PAYMENT_SUCCESS_MESSAGE,
            })

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send_payment)

        openai_calls: list[dict] = []

        async def fake_complete(messages, sid):
            openai_calls.append(1)
            raise AssertionError("OpenAI must not run after yes confirmation")

        with patch.object(runtime, "_complete", side_effect=fake_complete):
            confirm = await runtime.handle_turn(
                session,
                "Yes, that's correct",
                send,
            )

        assert not openai_calls
        assert get_canonical_confirmed_email(session) == LIVE_EMAIL
        assert email_sends["n"] == 1
        assert len(checkout_calls) == 1
        assert len(checkout_calls[0]["items"]) == 2
        assert checkout_calls[0]["email"] == LIVE_EMAIL
        assert "inbox" in confirm.response_text.lower()
        assert "http" not in confirm.response_text.lower()
        assert confirmation_prompt(LIVE_EMAIL) != confirm.response_text
