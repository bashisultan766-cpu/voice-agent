"""
v4.22 — Email capture + payment send hard-fix tests.

Covers deterministic confirmation, canonical session.confirmed_email, and the
exact live-log regression (repeat email → yes → send must not return no_email).
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
from app.agent_runtime.payment_flow_state import (
    PAYMENT_FAILURE_MESSAGE,
    PAYMENT_SUCCESS_MESSAGE,
    confirmation_prompt,
    enforce_payment_response,
    gate_send_payment_link,
    process_payment_turn,
    repeat_email_prompt,
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
from app.payment.safety import require_confirmed_email
from app.pipeline.email_capture import (
    is_email_confirmation,
    normalize_spoken_email,
    parse_hyphen_spelled_email,
)
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="v422",
        call_sid="CA_V422001",
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


class TestEmailCaptureFormats:
    @pytest.mark.parametrize(
        "utterance,expected",
        [
            ("bashisultan766@gmail.com", "bashisultan766@gmail.com"),
            ("bashi sultan 766 at gmail dot com", "bashisultan766@gmail.com"),
            (
                "b a s h i s u l t a n 7 6 6 at g mail dot com",
                "bashisultan766@gmail.com",
            ),
            ("bashi sultan 766 activate gmail dot com", "bashisultan766@gmail.com"),
            ("support@sureshotbooks.com", "support@sureshotbooks.com"),
            ("name@company.org", "name@company.org"),
            ("first.last@domain.co", "first.last@domain.co"),
            ("name+tag@gmail.com", "name+tag@gmail.com"),
        ],
    )
    def test_capture_sets_pending(self, utterance, expected):
        session = _session()
        _add_books(session, 1)
        hint = process_payment_turn(session, utterance)
        assert hint.force_reply
        assert expected in hint.force_reply
        assert "***" not in hint.force_reply
        assert get_pending_payment_email(session) == expected


class TestEmailConfirmation:
    def test_yes_thats_correct_email_confirms(self):
        session = _session()
        _add_books(session, 1)
        process_payment_turn(session, "bashisultan766@gmail.com")
        hint = process_payment_turn(session, "Yes. That's correct email.")
        assert hint.email_confirmed
        assert get_canonical_confirmed_email(session) == "bashisultan766@gmail.com"
        assert session.payment_email_confirmed is True
        assert session.awaiting_payment_email_confirmation is False

    def test_is_email_confirmation_phrase(self):
        assert is_email_confirmation("Yes. That's correct email.")
        assert is_email_confirmation("yeah that's right")
        assert not is_email_confirmation("no that's wrong")

    def test_correction_clears_old_and_sets_new(self):
        session = _session()
        _add_books(session, 1)
        process_payment_turn(session, "wrong@gmail.com")
        process_payment_turn(session, "No, not correct. My email is bashisultan766@gmail.com")
        assert get_canonical_confirmed_email(session) == ""
        assert get_pending_payment_email(session) == "bashisultan766@gmail.com"

    def test_repeat_email_preserves_pending(self):
        session = _session()
        _add_books(session, 1)
        process_payment_turn(session, "bashisultan766@gmail.com")
        session.pending_payment_email = ""
        session.pending_email = ""
        session.last_offered_payment_email = "bashisultan766@gmail.com"
        hint = process_payment_turn(session, "Can you repeat the email?")
        assert hint.force_reply
        assert "bashisultan766@gmail.com" in hint.force_reply or "gmail" in hint.force_reply.lower()
        assert get_pending_payment_email(session) == "bashisultan766@gmail.com"


class TestLiveLogRegression:
    """Exact sequence from production logs (v4.21 failure)."""

    @pytest.mark.asyncio
    async def test_repeat_spell_yes_send_no_no_email(self, monkeypatch):
        session = _session()
        _add_books(session, 3)
        process_payment_turn(session, "wrong@example.com")
        process_payment_turn(session, "No, my email is bashisultan766@gmail.com")
        assert get_pending_payment_email(session) == "bashisultan766@gmail.com"

        repeat_hint = process_payment_turn(session, "Can you repeat the email?")
        assert repeat_hint.force_reply

        yes_hint = process_payment_turn(session, "Yes. That's correct email.")
        assert yes_hint.email_confirmed
        assert get_canonical_confirmed_email(session) == "bashisultan766@gmail.com"
        sync_payment_email_fields(session)

        gate = gate_send_payment_link(session, "bashisultan766@gmail.com")
        assert gate.allowed
        if gate.tool_json:
            assert json.loads(gate.tool_json).get("error_code") != "no_email"

        send_attempted = {"called": False}

        async def fake_send(items, email="", customer_name=None, session=None):
            send_attempted["called"] = True
            assert get_canonical_confirmed_email(session) == "bashisultan766@gmail.com"
            return json.dumps({
                "success": True,
                "email_sent": True,
                "customer_message": PAYMENT_SUCCESS_MESSAGE,
            })

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        out = await llm_tools.dispatch(
            "send_payment_link",
            {"email": "bashisultan766@gmail.com"},
            session,
        )
        data = json.loads(out)
        assert send_attempted["called"]
        assert data.get("error_code") != "no_email"
        assert data.get("success") is True


class TestSendPaymentLinkCanonical:
    @pytest.mark.asyncio
    async def test_tool_arg_email_cannot_bypass_confirmation(self):
        session = _session()
        _add_books(session, 1)
        set_pending_payment_email(session, "pending@gmail.com")
        gate = gate_send_payment_link(session, "bypass@gmail.com")
        assert not gate.allowed
        out = await llm_tools.dispatch(
            "send_payment_link",
            {"email": "bypass@gmail.com"},
            session,
        )
        data = json.loads(out)
        assert data.get("success") is not True
        assert data.get("error_code") != "no_email" or not data.get("email_sent")

    @pytest.mark.asyncio
    async def test_confirmed_send_reads_session_only(self, monkeypatch):
        session = _session()
        _add_books(session, 1)
        set_pending_payment_email(session, "buyer@gmail.com")
        confirm_payment_email(session)

        async def fake_send(items, email="", customer_name=None, session=None):
            assert email == "buyer@gmail.com"
            return json.dumps({"success": True, "email_sent": True, "customer_message": PAYMENT_SUCCESS_MESSAGE})

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        out = await llm_tools.dispatch("send_payment_link", {"email": "other@gmail.com"}, session)
        data = json.loads(out)
        assert data["success"] is True
        assert data.get("error_code", "") != "no_email"


class TestPaymentGates:
    def test_create_checkout_blocked_before_confirm(self):
        session = _session()
        _add_books(session, 1)
        set_pending_payment_email(session, "a@gmail.com")
        gate = gate_tool_call("create_checkout", session)
        assert gate is not None and not gate.allowed

    def test_send_blocked_before_confirm(self):
        session = _session()
        _add_books(session, 1)
        set_pending_payment_email(session, "a@gmail.com")
        gate = gate_send_payment_link(session, "")
        assert not gate.allowed
        payload = json.loads(gate.tool_json)
        assert payload.get("error_code") == "email_unconfirmed"


class TestMultiBookCheckout:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("count", [3, 15])
    async def test_one_checkout_all_items(self, count, monkeypatch):
        session = _session()
        _add_books(session, count)
        set_pending_payment_email(session, "buyer@gmail.com")
        confirm_payment_email(session)
        seen: list[int] = []

        async def fake_checkout(items, email=None, phone=None, customer_name=None, session=None):
            seen.append(len(items))
            session.pending_checkout_url = "https://shop.test/pay/x"
            return json.dumps({"success": True})

        async def fake_email(**_k):
            return json.dumps({"success": True, "email_sent": True, "customer_message": PAYMENT_SUCCESS_MESSAGE})

        monkeypatch.setattr(llm_tools._st, "create_checkout_link", fake_checkout)
        monkeypatch.setattr(llm_tools._st, "send_payment_link_email_tool", fake_email)
        items = get_ledger(session).to_checkout_items()
        out = await llm_tools._st.SendPaymentLink(items=items, session=session)
        assert json.loads(out)["success"] is True
        assert seen == [count]


class TestResendOutcomes:
    @pytest.mark.asyncio
    async def test_resend_failure_no_false_success(self, monkeypatch):
        session = _session()
        _add_books(session, 1)
        set_pending_payment_email(session, "buyer@gmail.com")
        confirm_payment_email(session)

        async def fake_checkout(*_a, **_k):
            session.pending_checkout_url = "https://shop.test/pay"
            return json.dumps({"success": True})

        async def fake_email(**_k):
            return json.dumps({
                "success": False,
                "email_sent": False,
                "customer_message": PAYMENT_FAILURE_MESSAGE,
            })

        monkeypatch.setattr(llm_tools._st, "create_checkout_link", fake_checkout)
        monkeypatch.setattr(llm_tools._st, "send_payment_link_email_tool", fake_email)
        out = await llm_tools._st.SendPaymentLink(
            items=get_ledger(session).to_checkout_items(),
            session=session,
        )
        data = json.loads(out)
        assert data["success"] is False
        assert "created the payment link" not in data["customer_message"].lower()
        assert "direct link" not in data["customer_message"].lower()
        spoken = enforce_payment_response(session, "I created the payment link for you.", [("send_payment_link", data)])
        assert "direct link" not in spoken.lower()
        assert "http" not in spoken

    @pytest.mark.asyncio
    async def test_resend_success_message(self, monkeypatch):
        session = _session()
        _add_books(session, 1)
        set_pending_payment_email(session, "buyer@gmail.com")
        confirm_payment_email(session)

        async def fake_checkout(*_a, **_k):
            session.pending_checkout_url = "https://shop.test/pay"
            return json.dumps({"success": True})

        async def fake_email(**_k):
            return json.dumps({"success": True, "email_sent": True, "customer_message": PAYMENT_SUCCESS_MESSAGE})

        monkeypatch.setattr(llm_tools._st, "create_checkout_link", fake_checkout)
        monkeypatch.setattr(llm_tools._st, "send_payment_link_email_tool", fake_email)
        out = await llm_tools._st.SendPaymentLink(
            items=get_ledger(session).to_checkout_items(),
            session=session,
        )
        data = json.loads(out)
        assert "inbox" in data["customer_message"].lower()


class TestSpelledHyphenEmail:
    def test_parse_hyphen_spelled(self):
        spelled = "b-a-s-h-i-s-u-l-t-a-n-7-6-6-@-g-m-a-i-l-dot-c-o-m"
        assert parse_hyphen_spelled_email(spelled) == "bashisultan766@gmail.com"


class TestStaleFlags:
    def test_sync_clears_stale_payment_email_confirmed(self):
        session = _session()
        session.payment_email_confirmed = True
        session.confirmed_email = ""
        sync_payment_email_fields(session)
        assert session.payment_email_confirmed is False
        assert require_confirmed_email(session).allowed is False
