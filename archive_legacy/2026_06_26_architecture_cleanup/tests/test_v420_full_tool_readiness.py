"""
v4.20 — Full tool-readiness integration tests for llm_tool_runtime.

Covers multi-book cart, email confirmation gates, checkout ordering,
caller recognition, order/refund, newspaper search, and phrase guardrails.
No live network calls.
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
from app.agent_runtime.output_guardrails import apply_output_guardrails
from app.agent_runtime.payment_flow_state import (
    PAYMENT_SUCCESS_MESSAGE,
    gate_send_payment_link,
    process_payment_turn,
)
from app.agent_runtime.tool_runtime_gates import (
    gate_tool_call,
    replace_blocked_order_phrase,
)
from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
from app.email.capture import normalize_spoken_email
from app.email.speller import speak_email, spell_email_for_voice
from app.state.models import SessionState
from app.tools import voice_intent

_EMAIL = "bashisultan766@gmail.com"


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="v420",
        call_sid="CA_V420001",
        from_number="+15551230000",
        to_number="+15559999999",
        **kwargs,
    )


def _add_book(session: SessionState, title: str, isbn: str, vid: str) -> None:
    add_product_candidate(
        session,
        title=title,
        isbn=isbn,
        variant_id=vid,
        price="10.00",
    )
    confirm_last_candidate(session)


def _make_books(session: SessionState, count: int) -> None:
    for i in range(count):
        _add_book(
            session,
            title=f"Book {i + 1}",
            isbn=f"978000000000{i}",
            vid=f"gid://shopify/ProductVariant/{i + 1}",
        )
    session.payment_flow_status = "awaiting_email"
    session.payment_cart_confirmed = True


class TestMultiBookCart:
    @pytest.mark.asyncio
    async def test_three_books_one_checkout(self, monkeypatch):
        session = _session()
        _make_books(session, 3)
        checkout_calls = []

        async def fake_checkout(items, email=None, phone=None, customer_name=None, session=None):
            checkout_calls.append(len(items))
            return json.dumps({"success": True, "checkout_url": "https://shop.test/pay/1"})

        monkeypatch.setattr(llm_tools._st, "create_checkout_link", fake_checkout)
        session.confirmed_email = "buyer@gmail.com"
        session.payment_email_confirmed = True

        out = await llm_tools.dispatch("create_checkout", {}, session)
        data = json.loads(out)
        assert data.get("success") is True
        assert checkout_calls == [3]

    @pytest.mark.asyncio
    async def test_fifteen_books_one_checkout(self, monkeypatch):
        session = _session()
        _make_books(session, 15)
        checkout_calls = []

        async def fake_checkout(items, email=None, phone=None, customer_name=None, session=None):
            checkout_calls.append(len(items))
            return json.dumps({"success": True, "checkout_url": "https://shop.test/pay/2"})

        monkeypatch.setattr(llm_tools._st, "create_checkout_link", fake_checkout)
        session.confirmed_email = "buyer@yahoo.com"
        session.payment_email_confirmed = True

        await llm_tools.dispatch("create_checkout", {}, session)
        assert checkout_calls == [15]
        assert get_ledger(session).confirmed_count() == 15


class TestEmailConfirmationGates:
    def test_confirmation_prompt_has_full_email(self):
        session = _session()
        _make_books(session, 1)
        hint = process_payment_turn(session, "bashisultan766@gmail.com")
        assert hint.force_reply
        assert spell_email_for_voice(_EMAIL) in hint.force_reply
        assert "***" not in hint.force_reply

    def test_send_blocked_before_confirmation(self):
        session = _session()
        _make_books(session, 1)
        session.pending_payment_email = "test@gmail.com"
        session.awaiting_payment_email_confirmation = True
        gate = gate_send_payment_link(session)
        assert not gate.allowed
        payload = json.loads(gate.tool_json)
        assert speak_email("test@gmail.com") in payload["customer_message"]

    @pytest.mark.asyncio
    async def test_create_checkout_blocked_before_email_confirmed(self):
        session = _session()
        _make_books(session, 1)
        session.pending_payment_email = "alice@gmail.com"
        session.awaiting_payment_email_confirmation = True
        gate = gate_tool_call("create_checkout", session)
        assert gate is not None
        assert not gate.allowed

    @pytest.mark.asyncio
    async def test_add_to_cart_blocked_during_email_confirmation(self):
        session = _session()
        _make_books(session, 1)
        session.awaiting_payment_email_confirmation = True
        session.pending_payment_email = "alice@gmail.com"
        gate = gate_tool_call("add_to_cart", session)
        assert gate is not None
        assert not gate.allowed

    @pytest.mark.asyncio
    async def test_add_to_cart_blocked_after_checkout_started(self):
        session = _session()
        _make_books(session, 1)
        session.confirmed_email = "alice@gmail.com"
        session.payment_email_confirmed = True
        session.pending_checkout_url = "https://shop.test/pay/x"
        session.payment_flow_status = "awaiting_send_confirmation"
        gate = gate_tool_call("add_to_cart", session)
        assert gate is not None
        assert not gate.allowed


class TestEmailValidation:
    @pytest.mark.parametrize(
        "spoken,expected",
        [
            ("bashi at gmail dot com", "bashi@gmail.com"),
            ("name at yahoo dot com", "name@yahoo.com"),
            ("user at outlook dot com", "user@outlook.com"),
            ("contact at acme hyphen corp dot com", "contact@acme-corp.com"),
            ("name plus tag at gmail dot com", "name+tag@gmail.com"),
            ("b a s h i activate gmail dot com", "bashi@gmail.com"),
        ],
    )
    def test_spoken_email_normalization(self, spoken, expected):
        result = normalize_spoken_email(spoken)
        assert result == expected

    def test_activate_only_in_email_context(self):
        assert normalize_spoken_email("please activate my account") is None
        assert normalize_spoken_email("bashi activate gmail dot com") == "bashi@gmail.com"


class TestPaymentFlowOrdering:
    @pytest.mark.asyncio
    async def test_one_checkout_one_send(self, monkeypatch):
        session = _session()
        _make_books(session, 2)
        session.confirmed_email = "pay@gmail.com"
        session.payment_email_confirmed = True
        sends = []

        async def fake_send(items, email="", customer_name=None, session=None):
            sends.append(email)
            return json.dumps({
                "success": True,
                "email_sent": True,
                "customer_message": PAYMENT_SUCCESS_MESSAGE,
            })

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        out = await llm_tools.dispatch("send_payment_link", {}, session)
        data = json.loads(out)
        assert data["success"] is True
        assert sends == ["pay@gmail.com"]


class TestOrderRefund:
    @pytest.mark.asyncio
    async def test_order_lookup_uses_shopify_wrapper(self, monkeypatch):
        session = _session()

        async def fake_lookup(**kwargs):
            return json.dumps({"found": True, "order_number": "#1001", "status": "PAID"})

        monkeypatch.setattr(llm_tools._st, "lookup_order", fake_lookup)
        out = await llm_tools.dispatch(
            "lookup_order_status",
            {"order_number": "1001", "email": "a@b.com"},
            session,
        )
        data = json.loads(out)
        assert data["found"] is True

    @pytest.mark.asyncio
    async def test_refund_requires_verification_fields(self, monkeypatch):
        session = _session()

        async def fake_refund(**kwargs):
            assert kwargs.get("order_number")
            return json.dumps({"found": True, "verification_required": True})

        monkeypatch.setattr(llm_tools._st, "get_refund_status", fake_refund)
        out = await llm_tools.dispatch(
            "lookup_refund_status",
            {"order_number": "1001"},
            session,
        )
        assert json.loads(out)["found"] is True


class TestCallerRecognition:
    @pytest.mark.asyncio
    async def test_get_caller_info_first_name_only(self):
        session = SessionState(
            session_id="v420-caller",
            call_sid="CA_V420002",
            from_number="+15551234567",
            to_number="+15559999999",
        )

        async def fake_identity(phone, allow_live=True):
            return {
                "known": True,
                "first_name": "Terran",
                "allowed_greeting_name": "Terran",
                "customer_id": "gid://shopify/Customer/1",
                "phone_match_confidence": "high",
                "recent_orders": [
                    {"order_number": "#99", "status": "PAID", "fulfillment_status": ""}
                ],
            }

        with patch(
            "app.agent_runtime.caller_identity.get_caller_info",
            new=AsyncMock(side_effect=fake_identity),
        ):
            out = await llm_tools._st.GetCallerInfo(session=session)
        data = json.loads(out)
        assert data["recognized"] is True
        assert data["customer_first_name"] == "Terran"
        assert data["verification_required_for_sensitive_details"] is True


class TestProductSearch:
    def test_newspaper_intent_not_rejected(self):
        raw = voice_intent.normalize_voice_intent("I need a newspaper subscription")
        data = json.loads(raw)
        assert data["intent"] == "book_search"
        assert data.get("off_domain") != "medical"

    def test_usa_today_newspaper(self):
        raw = voice_intent.normalize_voice_intent(
            "USA TODAY Sports Weekly 3 months"
        )
        data = json.loads(raw)
        assert data["intent"] == "book_search"


class TestPhraseAndUrlGuardrails:
    def test_blocked_order_phrase_replaced(self):
        bad = "I'm sorry, I can't place orders directly over the phone."
        fixed = replace_blocked_order_phrase(bad)
        assert "can't place orders" not in fixed.lower()
        assert "secure payment link" in fixed.lower()

    def test_raw_url_never_spoken(self):
        guarded = apply_output_guardrails(
            "Here is your link https://checkout.shopify.com/pay/secret123"
        )
        assert "http" not in guarded.text.lower()
        assert "secret123" not in guarded.text

    def test_runtime_masks_llm_email_confirmation(self):
        runtime = LLMToolRuntime()
        session = _session()
        _make_books(session, 1)
        session.pending_payment_email = "bashisultan766@gmail.com"
        session.awaiting_payment_email_confirmation = True
        spoken = runtime._finalize(
            session,
            "Just to confirm, is that email address ***@***?",
        )
        assert spell_email_for_voice(_EMAIL) in spoken
        assert "***" not in spoken


class TestToolRegistryCompleteness:
    def test_all_registered_tools_audited_or_partial(self):
        from app.scripts.audit_tool_readiness import _tool_inventory

        names = set(llm_tools.tool_names())
        audited = {r.name for r in _tool_inventory()}
        missing = names - audited
        assert not missing, f"Unaudited tools: {missing}"

    def test_required_tools_not_broken(self):
        from app.scripts.audit_tool_readiness import _tool_inventory

        broken = [r.name for r in _tool_inventory() if r.readiness == "broken"]
        assert not broken
