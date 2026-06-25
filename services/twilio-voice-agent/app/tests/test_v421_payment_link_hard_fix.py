"""
v4.21 — Hard-fix tests for payment link email flow.

Reproduces live-call failure: send_payment_link no_email after confirmation.
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
    process_payment_turn,
)
from app.agent_runtime.tool_runtime_gates import gate_tool_call
from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
from app.payment.email_state import (
    confirm_payment_email,
    get_canonical_confirmed_email,
    set_pending_payment_email,
    sync_payment_email_fields,
)
from app.payment.safety import require_confirmed_email, require_payment_send_ready
from app.pipeline.email_capture import normalize_spoken_email
from app.pipeline.email_speller import speak_email, spell_email_for_voice
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="v421",
        call_sid="CA_V421001",
        from_number="+15551230000",
        to_number="+15559999999",
        **kwargs,
    )


def _add_book(session: SessionState, n: int = 1) -> None:
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


class TestEmailCaptureDoesNotSendEarly:
    @pytest.mark.asyncio
    async def test_email_only_no_checkout_or_send(self, monkeypatch):
        session = _session()
        _add_book(session, 1)
        checkout_called = send_called = False

        async def fake_checkout(*_a, **_k):
            checkout_called = True
            return "{}"

        async def fake_send(*_a, **_k):
            send_called = True
            return "{}"

        monkeypatch.setattr(llm_tools._st, "create_checkout_link", fake_checkout)
        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)

        hint = process_payment_turn(session, "bashisultan766@gmail.com")
        assert hint.force_reply
        assert speak_email("bashisultan766@gmail.com") in hint.force_reply
        assert spell_email_for_voice("bashisultan766@gmail.com") in hint.force_reply
        assert "***" not in hint.force_reply
        assert not checkout_called
        assert not send_called

        gate = gate_tool_call("create_checkout", session)
        assert gate is not None and not gate.allowed
        gate = gate_tool_call("send_payment_link", session)
        assert gate is not None and not gate.allowed


class TestConfirmedEmailCanonicalField:
    def test_yes_stores_confirmed_email(self):
        session = _session()
        _add_book(session, 1)
        process_payment_turn(session, "bashisultan766@gmail.com")
        process_payment_turn(session, "yes that's correct")
        assert get_canonical_confirmed_email(session) == "bashisultan766@gmail.com"
        assert session.payment_email_confirmed is True
        assert require_confirmed_email(session).allowed

    @pytest.mark.asyncio
    async def test_send_after_yes_not_no_email(self, monkeypatch):
        session = _session()
        _add_book(session, 1)
        process_payment_turn(session, "bashisultan766@gmail.com")
        process_payment_turn(session, "yes correct")

        async def fake_send(items, email="", customer_name=None, session=None):
            assert email == "bashisultan766@gmail.com"
            assert get_canonical_confirmed_email(session) == "bashisultan766@gmail.com"
            return json.dumps({
                "success": True,
                "email_sent": True,
                "customer_message": PAYMENT_SUCCESS_MESSAGE,
            })

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        out = await llm_tools.dispatch("send_payment_link", {"email": "bashisultan766@gmail.com"}, session)
        data = json.loads(out)
        assert data.get("success") is True
        assert data.get("email_sent") is True
        assert data.get("error_code", "") != "no_email"


class TestEmailDomains:
    @pytest.mark.parametrize(
        "email",
        [
            "user@gmail.com",
            "user@yahoo.com",
            "user@outlook.com",
            "user@hotmail.com",
            "user@icloud.com",
            "contact@acme-corp.com",
            "name+tag@gmail.com",
            "first_last@company.org",
        ],
    )
    @pytest.mark.asyncio
    async def test_confirmed_domain_send_allowed(self, email, monkeypatch):
        session = _session()
        _add_book(session, 1)
        set_pending_payment_email(session, email)
        confirm_payment_email(session)

        async def fake_send(items, email="", customer_name=None, session=None):
            return json.dumps({"success": True, "email_sent": True, "customer_message": PAYMENT_SUCCESS_MESSAGE})

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        gate = gate_send_payment_link(session, email)
        assert gate.allowed
        out = await llm_tools.dispatch("send_payment_link", {"email": email}, session)
        assert json.loads(out)["success"] is True


class TestSpokenEmailNormalization:
    @pytest.mark.parametrize(
        "spoken,expected",
        [
            ("bashi activate gmail dot com", "bashi@gmail.com"),
            ("name plus tag at gmail dot com", "name+tag@gmail.com"),
            ("user underscore name at yahoo dot com", "user_name@yahoo.com"),
            ("contact at acme hyphen corp dot com", "contact@acme-corp.com"),
        ],
    )
    def test_normalization(self, spoken, expected):
        assert normalize_spoken_email(spoken) == expected

    def test_activate_not_in_non_email_context(self):
        assert normalize_spoken_email("please activate my account") is None


class TestMultiBookCheckout:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("count", [3, 15])
    async def test_one_checkout_all_items(self, count, monkeypatch):
        session = _session()
        _add_book(session, count)
        set_pending_payment_email(session, "buyer@gmail.com")
        confirm_payment_email(session)
        seen = []

        async def fake_checkout(items, email=None, phone=None, customer_name=None, session=None):
            seen.append(len(items))
            session.pending_checkout_url = "https://shop.test/pay/x"
            session.pending_draft_order_id = "D8916"
            return json.dumps({"success": True, "checkout_url": session.pending_checkout_url})

        async def fake_email(**kwargs):
            return json.dumps({"success": True, "email_sent": True, "customer_message": PAYMENT_SUCCESS_MESSAGE})

        monkeypatch.setattr(llm_tools._st, "create_checkout_link", fake_checkout)
        monkeypatch.setattr(llm_tools._st, "send_payment_link_email_tool", fake_email)

        items = get_ledger(session).to_checkout_items()
        out = await llm_tools._st.SendPaymentLink(items=items, session=session)
        data = json.loads(out)
        assert data["success"] is True
        assert seen == [count]
        for item in items:
            assert item.get("variant_id")
            assert int(item.get("quantity", 0)) >= 1


class TestGatesAndSafety:
    @pytest.mark.asyncio
    async def test_create_checkout_blocked_before_confirm(self):
        session = _session()
        _add_book(session, 1)
        set_pending_payment_email(session, "a@gmail.com")
        gate = gate_tool_call("create_checkout", session)
        assert gate is not None and not gate.allowed

    @pytest.mark.asyncio
    async def test_send_blocked_before_confirm(self):
        session = _session()
        _add_book(session, 1)
        set_pending_payment_email(session, "a@gmail.com")
        gate = gate_send_payment_link(session, "a@gmail.com")
        assert not gate.allowed

    @pytest.mark.asyncio
    async def test_failure_no_checkout_url_in_response(self, monkeypatch):
        session = _session()
        _add_book(session, 1)
        set_pending_payment_email(session, "a@gmail.com")
        confirm_payment_email(session)

        async def fake_checkout(*_a, **_k):
            session.pending_checkout_url = "https://secret.checkout/url"
            return json.dumps({"success": True})

        async def fake_email_tool(**_k):
            return json.dumps({
                "success": False,
                "email_sent": False,
                "customer_message": PAYMENT_FAILURE_MESSAGE,
                "error_code": "email_send_failed",
            })

        monkeypatch.setattr(llm_tools._st, "create_checkout_link", fake_checkout)
        monkeypatch.setattr(llm_tools._st, "send_payment_link_email_tool", fake_email_tool)
        items = get_ledger(session).to_checkout_items()
        out = await llm_tools._st.SendPaymentLink(items=items, session=session)
        assert "http" not in out
        assert "secret.checkout" not in out

    @pytest.mark.asyncio
    async def test_success_message_safe(self, monkeypatch):
        session = _session()
        _add_book(session, 1)
        set_pending_payment_email(session, "buyer@gmail.com")
        confirm_payment_email(session)

        async def fake_checkout(*_a, **_k):
            session.pending_checkout_url = "https://shop.test/pay"
            return json.dumps({"success": True})

        async def fake_email_tool(**_k):
            return json.dumps({
                "success": True,
                "email_sent": True,
                "customer_message": PAYMENT_SUCCESS_MESSAGE,
            })

        monkeypatch.setattr(llm_tools._st, "create_checkout_link", fake_checkout)
        monkeypatch.setattr(llm_tools._st, "send_payment_link_email_tool", fake_email_tool)
        items = get_ledger(session).to_checkout_items()
        out = await llm_tools._st.SendPaymentLink(items=items, session=session)
        data = json.loads(out)
        assert "inbox" in data["customer_message"].lower()
        assert "http" not in data["customer_message"]

    @pytest.mark.asyncio
    async def test_retry_reuses_checkout_url(self, monkeypatch):
        session = _session()
        _add_book(session, 1)
        set_pending_payment_email(session, "buyer@gmail.com")
        confirm_payment_email(session)
        session.pending_checkout_url = "https://shop.test/existing"
        session.pending_draft_order_id = "D8916"
        calls = []

        async def fake_checkout(*_a, **_k):
            calls.append("checkout")
            return json.dumps({"success": True, "duplicate": True})

        async def fake_email_tool(**_k):
            return json.dumps({
                "success": True,
                "email_sent": True,
                "customer_message": PAYMENT_SUCCESS_MESSAGE,
            })

        monkeypatch.setattr(llm_tools._st, "create_checkout_link", fake_checkout)
        monkeypatch.setattr(llm_tools._st, "send_payment_link_email_tool", fake_email_tool)
        items = get_ledger(session).to_checkout_items()
        await llm_tools._st.SendPaymentLink(items=items, session=session)
        assert calls == ["checkout"]


class TestRuntimeAutoSend:
    @pytest.mark.asyncio
    async def test_auto_send_after_yes(self, monkeypatch):
        runtime = LLMToolRuntime()
        session = _session()
        _add_book(session, 1)
        process_payment_turn(session, "buyer@gmail.com")

        async def fake_dispatch(name, args, session):
            assert name == "send_payment_link"
            assert get_canonical_confirmed_email(session) == "buyer@gmail.com"
            return json.dumps({
                "success": True,
                "email_sent": True,
                "customer_message": PAYMENT_SUCCESS_MESSAGE,
            })

        monkeypatch.setattr(llm_tools, "dispatch", fake_dispatch)
        sent = []

        async def send(msg):
            sent.append(msg)

        result = await runtime.handle_turn(session, "yes that's correct", send)
        assert "inbox" in result.response_text.lower()
        assert "http" not in result.response_text

    def test_no_order_number_claim_before_send(self):
        session = _session()
        out = enforce_payment_response(
            session,
            "I created order number D8916 for you.",
            [("send_payment_link", {"success": False, "email_sent": False, "customer_message": PAYMENT_FAILURE_MESSAGE})],
        )
        assert "D8916" not in out
        assert PAYMENT_FAILURE_MESSAGE in out

    def test_no_direct_link_phrase(self):
        from app.agent_runtime.payment_flow_state import scrub_false_payment_claims

        out = scrub_false_payment_claims("Use the direct URL from our conversation.")
        assert "direct url" not in out.lower()
        assert "inbox" in out.lower() or "sorry" in out.lower()


class TestDiagnosticsLogging:
    def test_sync_keeps_fields_aligned(self, caplog):
        import logging

        session = _session()
        set_pending_payment_email(session, "diag@gmail.com")
        confirm_payment_email(session)
        with caplog.at_level(logging.INFO):
            from app.payment.email_state import log_payment_flow_diagnostics

            log_payment_flow_diagnostics(session, stage="test")
        assert any("payment_flow_diag" in r.message for r in caplog.records)
        assert any("confirmed_email_present=True" in r.message for r in caplog.records)
        sync_payment_email_fields(session)
        assert require_payment_send_ready(session).allowed
