"""
v4.19 — Payment/email confirmation state machine tests for LLM runtime.
"""
from __future__ import annotations

import asyncio
import json
import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime import llm_tools
from app.agent_runtime.llm_tool_runtime import LLMToolRuntime
from app.agent_runtime.output_guardrails import apply_output_guardrails
from app.agent_runtime.payment_flow_state import (
    PAYMENT_FAILURE_MESSAGE,
    PAYMENT_SUCCESS_MESSAGE,
    enforce_payment_response,
    gate_send_payment_link,
    process_payment_turn,
)
from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    s = SessionState(
        session_id="pay", call_sid="CA_PAY001",
        from_number="+15551230000", to_number="+15559999999",
        **kwargs,
    )
    return s


def _cart_with_book(session: SessionState) -> None:
    add_product_candidate(
        session,
        title="Dune",
        isbn="9780441172719",
        variant_id="gid://shopify/ProductVariant/1",
        price="10.00",
    )
    confirm_last_candidate(session)
    session.payment_cart_confirmed = True
    session.payment_flow_status = "awaiting_email"


class TestPaymentStateMachine:
    def test_email_provided_does_not_confirm_immediately(self):
        session = _session()
        _cart_with_book(session)
        hint = process_payment_turn(session, "Yes. My email address is bashisultan766@gmail.com")
        assert hint.force_reply is not None
        assert "bashisultan766@gmail.com" in hint.force_reply
        assert session.awaiting_payment_email_confirmation is True
        assert session.payment_email_confirmed is False
        assert session.pending_payment_email == "bashisultan766@gmail.com"

    def test_yes_after_pending_confirms_email(self):
        session = _session()
        _cart_with_book(session)
        process_payment_turn(session, "bashisultan766@gmail.com")
        hint = process_payment_turn(session, "yes that's correct")
        assert hint.email_confirmed is True
        assert session.payment_email_confirmed is True
        assert session.confirmed_email == "bashisultan766@gmail.com"
        assert session.awaiting_payment_email_confirmation is False

    def test_gate_blocks_unconfirmed_send(self):
        session = _session()
        _cart_with_book(session)
        session.pending_payment_email = "test@gmail.com"
        session.awaiting_payment_email_confirmation = True
        gate = gate_send_payment_link(session, "test@gmail.com")
        assert gate.allowed is False
        data = json.loads(gate.tool_json)
        assert data["success"] is False
        assert data["error_code"] == "email_unconfirmed"


class TestSendPaymentLinkTool:
    @pytest.mark.asyncio
    async def test_unconfirmed_email_blocked_without_checkout(self):
        session = _session()
        _cart_with_book(session)
        session.pending_payment_email = "alice@gmail.com"
        session.awaiting_payment_email_confirmation = True
        out = await llm_tools.dispatch(
            "send_payment_link", {"email": "alice@gmail.com"}, session,
        )
        data = json.loads(out)
        assert data["success"] is False
        assert data["email_sent"] is False
        assert "confirm" in data["customer_message"].lower()

    @pytest.mark.asyncio
    async def test_confirmed_email_reaches_send_layer(self, monkeypatch):
        session = _session()
        _cart_with_book(session)
        session.confirmed_email = "alice@gmail.com"
        session.payment_email_confirmed = True
        session.pending_checkout_url = "https://shop.test/checkout/abc"

        called = {}

        async def fake_send(items, email="", customer_email="", to_email="",
                            customer_name=None, session=None):
            called["email"] = email
            return json.dumps({
                "success": True,
                "email_sent": True,
                "customer_message": PAYMENT_SUCCESS_MESSAGE,
            })

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        out = await llm_tools.dispatch("send_payment_link", {"email": "alice@gmail.com"}, session)
        data = json.loads(out)
        assert data["success"] is True
        assert called["email"] == "alice@gmail.com"

    @pytest.mark.asyncio
    async def test_customer_email_alias_accepted(self, monkeypatch):
        session = _session()
        _cart_with_book(session)
        session.confirmed_email = "bob@gmail.com"
        session.payment_email_confirmed = True
        session.pending_checkout_url = "https://shop.test/checkout/abc"

        async def fake_send(items, email="", customer_email="", to_email="",
                            customer_name=None, session=None):
            return json.dumps({"success": True, "email_sent": True,
                               "customer_message": PAYMENT_SUCCESS_MESSAGE})

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        gate = gate_send_payment_link(session, "bob@gmail.com")
        assert gate.allowed is True

    @pytest.mark.asyncio
    async def test_failure_does_not_expose_checkout_url(self, monkeypatch):
        session = _session()
        _cart_with_book(session)
        session.confirmed_email = "alice@gmail.com"
        session.payment_email_confirmed = True

        async def fake_send(*_a, **_k):
            return json.dumps({
                "success": False,
                "email_sent": False,
                "customer_message": PAYMENT_FAILURE_MESSAGE,
                "error_code": "email_send_failed",
            })

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        out = await llm_tools.dispatch("send_payment_link", {}, session)
        data = json.loads(out)
        assert "checkout_url" not in out
        assert data["success"] is False
        assert "url" not in data["customer_message"].lower()


class TestPaymentResponseGuard:
    def test_failure_overrides_llm_success_claim(self):
        session = _session()
        tool_results = [("send_payment_link", {
            "success": False,
            "email_sent": False,
            "customer_message": PAYMENT_FAILURE_MESSAGE,
        })]
        out = enforce_payment_response(
            session,
            "I created your payment link. Use the direct URL from our conversation.",
            tool_results,
        )
        assert out == PAYMENT_FAILURE_MESSAGE
        assert "url" not in out.lower()

    def test_success_uses_tool_message(self):
        session = _session()
        tool_results = [("send_payment_link", {
            "success": True,
            "email_sent": True,
            "customer_message": PAYMENT_SUCCESS_MESSAGE,
        })]
        out = enforce_payment_response(session, "Here is your link https://x.com", tool_results)
        assert out == PAYMENT_SUCCESS_MESSAGE
        assert "http" not in out


class TestLLMRuntimePaymentShortCircuit:
    @pytest.mark.asyncio
    async def test_email_turn_short_circuits_without_send_tool(self):
        runtime = LLMToolRuntime()
        session = _session()
        _cart_with_book(session)

        sent = []

        async def send(msg):
            sent.append(msg)

        result = await runtime.handle_turn(
            session,
            "My email is bashisultan766@gmail.com",
            send,
        )
        assert "bashisultan766@gmail.com" in result.response_text
        assert "correct" in result.response_text.lower()
        tool_msgs = [m for m in session.history if m.get("role") == "tool"]
        assert not tool_msgs


class TestOutputGuardrailUrlSentence:
    def test_url_sentence_replaced_safely(self):
        guarded = apply_output_guardrails(
            "I created your payment link. Use this URL https://checkout.shopify.com/pay/abc.",
        )
        assert "http" not in guarded.text
        assert "can't read payment links aloud" in guarded.text
        assert "secure link I emailed you" not in guarded.text

    def test_success_phrase_unchanged(self):
        guarded = apply_output_guardrails(PAYMENT_SUCCESS_MESSAGE)
        assert guarded.text == PAYMENT_SUCCESS_MESSAGE
