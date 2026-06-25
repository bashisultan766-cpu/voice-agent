"""
v4.26 — Deterministic payment email state machine tests.

Covers email capture, confirmation, speak/spell format, LLM bypass, and
payment send gates.
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
    PAYMENT_FAILURE_MESSAGE,
    PAYMENT_SUCCESS_MESSAGE,
    enforce_payment_response,
    gate_send_payment_link,
    scrub_false_payment_claims,
)
from app.agent_runtime.tool_runtime_gates import gate_tool_call
from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
from app.payment.email_state import (
    confirm_payment_email,
    get_canonical_confirmed_email,
    get_pending_payment_email,
    set_pending_payment_email,
    sync_payment_email_fields,
)
from app.payment.payment_link_service import send_confirmed_payment_link
from app.payment.payment_state_machine import (
    capture_payment_email,
    confirmation_prompt,
    process_payment_turn,
)
from app.pipeline.email_capture import normalize_spoken_email, parse_hyphen_spelled_email
from app.pipeline.email_speller import speak_email, spell_email_for_voice
from app.state.models import SessionState

EMAIL = "bashisultan766@gmail.com"


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="v426",
        call_sid="CA_V426001",
        from_number="+15551230000",
        to_number="+15559999999",
        **kwargs,
    )


def _add_books(session: SessionState, n: int = 1) -> None:
    for i in range(n):
        add_product_candidate(
            session,
            title=f"Book {i + 1}",
            isbn=f"97800000000{i:02d}",
            variant_id=f"gid://shopify/ProductVariant/{i + 1}",
            price="10.00",
        )
        confirm_last_candidate(session)
    session.payment_flow_status = "awaiting_email"
    session.payment_cart_confirmed = True


class TestEmailNormalization:
    def test_direct_email_captured(self):
        assert normalize_spoken_email(EMAIL) == EMAIL

    def test_spoken_email_captured(self):
        spoken = "bashi sultan 766 at gmail dot com"
        assert normalize_spoken_email(spoken) == EMAIL

    def test_spelled_email_captured(self):
        spelled = "b a s h i s u l t a n 7 6 6 at g mail dot com"
        assert normalize_spoken_email(spelled) == EMAIL

    def test_activate_becomes_at(self):
        utterance = "bashi sultan 766 activate gmail dot com"
        assert normalize_spoken_email(utterance) == EMAIL

    def test_g_mail_becomes_gmail(self):
        utterance = "bashisultan766 at g mail dot com"
        assert normalize_spoken_email(utterance) == EMAIL


class TestEmailSpeaking:
    def test_speak_email_uses_dot(self):
        spoken = speak_email(EMAIL)
        assert " at gmail dot com" in spoken
        assert "@" not in spoken
        assert "." not in spoken
        assert "period" not in spoken.lower()

    def test_spell_email_uses_dot_not_period(self):
        spelled = spell_email_for_voice(EMAIL)
        assert "dot com" in spelled
        assert "period" not in spelled.lower()
        assert "." not in spelled

    def test_confirmation_includes_full_and_spelled(self):
        prompt = confirmation_prompt(EMAIL)
        assert speak_email(EMAIL) in prompt
        assert spell_email_for_voice(EMAIL) in prompt
        assert "Is that correct?" in prompt

    def test_confirmation_not_masked(self):
        session = _session()
        _add_books(session, 1)
        hint = process_payment_turn(session, EMAIL)
        assert hint.force_reply
        assert "***" not in hint.force_reply
        assert "bashisultan766" in hint.force_reply


class TestEmailTurnShortCircuit:
    @pytest.mark.asyncio
    async def test_email_turn_skips_openai(self, monkeypatch):
        session = _session()
        _add_books(session, 2)
        runtime = LLMToolRuntime()
        openai_called = {"n": 0}

        async def fake_openai(*_a, **_k):
            openai_called["n"] += 1
            return "should not run"

        monkeypatch.setattr(runtime, "_run_tool_loop", fake_openai)
        sent: list[str] = []

        async def send(msg):
            if msg.get("token"):
                sent.append(msg["token"])

        await runtime.handle_turn(
            session,
            "bashi sultan 766 at gmail dot com",
            send,
            assembled_turn_mode="email",
        )
        assert openai_called["n"] == 0
        assert any("Just to confirm" in t for t in sent)


class TestEmailConfirmation:
    def test_yes_confirms_pending_email(self):
        session = _session()
        _add_books(session, 1)
        process_payment_turn(session, EMAIL)
        hint = process_payment_turn(session, "Yeah, that's correct")
        assert hint.email_confirmed
        assert session.payment_email_confirmed is True

    def test_confirmed_email_is_session_field(self):
        session = _session()
        _add_books(session, 1)
        process_payment_turn(session, EMAIL)
        process_payment_turn(session, "yes")
        assert get_canonical_confirmed_email(session) == EMAIL
        assert session.confirmed_email == EMAIL


class TestPaymentSend:
    @pytest.mark.asyncio
    async def test_send_uses_confirmed_email_only(self, monkeypatch):
        session = _session()
        _add_books(session, 1)
        set_pending_payment_email(session, EMAIL)
        confirm_payment_email(session)
        seen: dict = {}

        async def fake_send(items, email="", customer_name=None, session=None):
            seen["email"] = email
            return json.dumps({
                "success": True,
                "email_sent": True,
                "customer_message": PAYMENT_SUCCESS_MESSAGE,
            })

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        out = await llm_tools.dispatch("send_payment_link", {"email": "other@gmail.com"}, session)
        data = json.loads(out)
        assert data["success"] is True
        assert seen["email"] == EMAIL

    @pytest.mark.asyncio
    async def test_llm_email_arg_ignored(self, monkeypatch):
        session = _session()
        _add_books(session, 1)
        set_pending_payment_email(session, EMAIL)
        confirm_payment_email(session)

        async def fake_send(items, email="", customer_name=None, session=None):
            assert email == EMAIL
            return json.dumps({"success": True, "email_sent": True, "customer_message": PAYMENT_SUCCESS_MESSAGE})

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        out = await llm_tools.dispatch("send_payment_link", {"email": "bypass@gmail.com"}, session)
        assert json.loads(out)["success"] is True

    def test_send_blocked_before_confirmation(self):
        session = _session()
        _add_books(session, 1)
        set_pending_payment_email(session, EMAIL)
        gate = gate_send_payment_link(session, "")
        assert not gate.allowed
        assert json.loads(gate.tool_json)["error_code"] == "email_unconfirmed"

    def test_create_checkout_absent_from_tool_specs(self):
        names = {s["function"]["name"] for s in llm_tools.tool_specs()}
        assert "create_checkout" not in names

    @pytest.mark.asyncio
    @pytest.mark.parametrize("count", [2, 15])
    async def test_one_checkout_for_cart(self, count, monkeypatch):
        session = _session()
        _add_books(session, count)
        set_pending_payment_email(session, "buyer@gmail.com")
        confirm_payment_email(session)
        seen: list[int] = []

        async def fake_checkout(items, email=None, phone=None, customer_name=None, session=None):
            seen.append(len(items))
            session.pending_checkout_url = "https://shop.test/pay/x"
            session.checkout_url = session.pending_checkout_url
            return json.dumps({"success": True, "checkout_url": session.pending_checkout_url})

        async def fake_email(**_k):
            return json.dumps({"success": True, "email_sent": True, "customer_message": PAYMENT_SUCCESS_MESSAGE})

        monkeypatch.setattr(llm_tools._st, "create_checkout_link", fake_checkout)
        monkeypatch.setattr(llm_tools._st, "send_payment_link_email_tool", fake_email)
        out = await llm_tools._st.SendPaymentLink(
            items=get_ledger(session).to_checkout_items(),
            session=session,
        )
        assert json.loads(out)["success"] is True
        assert seen == [count]

    @pytest.mark.asyncio
    async def test_retry_reuses_checkout_url(self, monkeypatch):
        session = _session()
        _add_books(session, 1)
        set_pending_payment_email(session, "buyer@gmail.com")
        confirm_payment_email(session)
        session.pending_checkout_url = "https://shop.test/existing"
        session.checkout_url = session.pending_checkout_url
        checkout_calls = {"n": 0}

        async def fake_checkout(*_a, **_k):
            checkout_calls["n"] += 1
            return json.dumps({"success": True})

        async def fake_email(**_k):
            return json.dumps({"success": True, "email_sent": True, "customer_message": PAYMENT_SUCCESS_MESSAGE})

        monkeypatch.setattr(llm_tools._st, "create_checkout_link", fake_checkout)
        monkeypatch.setattr(llm_tools._st, "send_payment_link_email_tool", fake_email)
        await send_confirmed_payment_link(session)
        assert checkout_calls["n"] == 1

    @pytest.mark.asyncio
    async def test_resend_success_phrase(self, monkeypatch):
        session = _session()
        _add_books(session, 1)
        set_pending_payment_email(session, "buyer@gmail.com")
        confirm_payment_email(session)

        async def fake_send(*_a, **_k):
            return json.dumps({"success": True, "email_sent": True, "customer_message": PAYMENT_SUCCESS_MESSAGE})

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        out = await llm_tools.dispatch("send_payment_link", {}, session)
        assert "inbox" in json.loads(out)["customer_message"].lower()

    @pytest.mark.asyncio
    async def test_resend_failure_no_false_success(self, monkeypatch):
        session = _session()
        _add_books(session, 1)
        set_pending_payment_email(session, "buyer@gmail.com")
        confirm_payment_email(session)

        async def fake_send(*_a, **_k):
            return json.dumps({
                "success": False,
                "email_sent": False,
                "customer_message": PAYMENT_FAILURE_MESSAGE,
            })

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        out = await llm_tools.dispatch("send_payment_link", {}, session)
        data = json.loads(out)
        assert data["success"] is False
        assert session.email_send_success is False
        spoken = enforce_payment_response(session, "I created the payment link.", [("send_payment_link", data)])
        assert "created the payment link" not in spoken.lower() or "sorry" in spoken.lower()

    def test_raw_url_never_spoken(self):
        out = scrub_false_payment_claims("Here is https://checkout.example.com/pay")
        assert "http" not in out

    def test_direct_link_never_spoken(self):
        out = scrub_false_payment_claims("I can give you the direct link.")
        assert "direct link" not in out.lower()

    def test_no_created_claim_before_email_sent(self):
        data = {"success": False, "email_sent": False, "customer_message": PAYMENT_FAILURE_MESSAGE}
        spoken = enforce_payment_response(_session(), "I created the payment link for you.", [("send_payment_link", data)])
        assert "created the payment link" not in spoken.lower() or "sorry" in spoken.lower()


class TestLiveLogRegression:
    @pytest.mark.asyncio
    async def test_spoken_email_yes_send_succeeds(self, monkeypatch):
        session = _session()
        _add_books(session, 2)
        capture_hint = process_payment_turn(
            session,
            "b a s h i s u l t a n 7 6 6 at g mail dot com",
        )
        assert capture_hint.force_reply
        assert "***" not in capture_hint.force_reply
        assert get_pending_payment_email(session) == EMAIL

        yes_hint = process_payment_turn(session, "Yeah, that's correct")
        assert yes_hint.email_confirmed
        sync_payment_email_fields(session)
        assert get_canonical_confirmed_email(session) == EMAIL
        assert session.payment_email_confirmed is True

        gate = gate_send_payment_link(session, "")
        assert gate.allowed

        async def fake_send(items, email="", customer_name=None, session=None):
            assert get_canonical_confirmed_email(session) == EMAIL
            return json.dumps({
                "success": True,
                "email_sent": True,
                "customer_message": PAYMENT_SUCCESS_MESSAGE,
            })

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        out = await llm_tools.dispatch("send_payment_link", {}, session)
        data = json.loads(out)
        assert data.get("error_code") != "no_email"
        assert data.get("error_code") != "email_unconfirmed"
        assert data["success"] is True
        assert session.email_send_success is True
