"""
v4.25 — Live deploy identity, Yes handling, email spelling, progress sends.

Proves the code PM2 should serve matches test expectations.
"""
from __future__ import annotations

import asyncio
import json
import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.agent_runtime import llm_tools
from app.agent_runtime.commerce_flow_state import (
    STATUS_AWAITING_ANOTHER_BOOK,
    STATUS_AWAITING_BOOK_CONFIRM,
    STATUS_AWAITING_QUANTITY,
    another_book_after_add_prompt,
    confirm_book_prompt,
    process_commerce_turn,
    stage_product_candidate,
)
from app.agent_runtime.llm_tool_runtime import LLMToolRuntime
from app.agent_runtime.payment_flow_state import (
    PAYMENT_SUCCESS_MESSAGE,
    confirmation_prompt,
    process_payment_turn,
    scrub_false_payment_claims,
)
from app.agent_runtime.runtime_identity import collect_runtime_identity, validate_runtime_identity
from app.agent_runtime.tool_progress import dispatch_with_progress, progress_phrase_for_tool
from app.agent_runtime.tool_runtime_gates import gate_tool_call
from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
from app.payment.email_state import get_canonical_confirmed_email, get_pending_payment_email
from app.pipeline.email_capture import is_email_confirmation, is_email_spell_request
from app.pipeline.email_speller import speak_email, spell_email_for_voice
from app.state.models import SessionState


BOOK_A = {
    "title": "100,000 and Freedom Too",
    "isbn": "9780997361308",
    "variant_id": "gid://shopify/ProductVariant/a",
    "price": "$16.23",
}
BOOK_B = {
    "title": "Hater",
    "isbn": "9781938857669",
    "variant_id": "gid://shopify/ProductVariant/b",
    "price": "$34.65",
}
EMAIL = "bashisultan766@gmail.com"


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="v425",
        call_sid="CA_V425001",
        from_number="+15551230000",
        to_number="+15559999999",
        **kwargs,
    )


class TestRuntimeIdentity:
    def test_identity_reports_v424_flags(self):
        identity = collect_runtime_identity()
        assert identity["voice_sales_flow_version"] == "v4.30"
        assert identity["tool_progress_prompts_enabled"] is True
        assert identity["payment_email_state_version"] == "v4.30"
        assert identity["email_capture_short_circuit_enabled"] is True
        assert identity["create_checkout_present_in_tool_specs"] is False
        assert identity["master_prompt_chars"] >= 12000

    def test_identity_validation_passes_locally(self):
        failures = validate_runtime_identity(collect_runtime_identity())
        assert failures == []

    def test_runtime_identity_script_exit_zero(self):
        from app.scripts.runtime_identity_check import main

        assert main() == 0


class TestToolSpecs:
    def test_create_checkout_not_exposed(self):
        names = {s["function"]["name"] for s in llm_tools.tool_specs()}
        assert "create_checkout" not in names
        assert "send_payment_link" in names


class TestYesHandling:
    def test_yes_means_one_copy_then_add_confirm(self):
        session = _session()
        stage_product_candidate(session, BOOK_A)
        h1 = process_commerce_turn(session, "Yes")
        assert h1.force_reply
        assert "Shall I add one copy" in h1.force_reply
        h2 = process_commerce_turn(session, "Yes")
        assert h2.book_added
        assert get_ledger(session).confirmed_count() == 1
        assert "another book" in h2.force_reply.lower()

    def test_repeated_yes_does_not_stall(self):
        session = _session()
        stage_product_candidate(session, BOOK_A)
        process_commerce_turn(session, "Yes")
        process_commerce_turn(session, "Yes")
        session.commerce_flow_status = STATUS_AWAITING_ANOTHER_BOOK
        h2 = process_commerce_turn(session, "Yes")
        assert h2.force_reply
        assert "isbn" in h2.force_reply.lower() or "title" in h2.force_reply.lower()

    def test_last_product_candidate_yes_when_awaiting_flag(self):
        session = _session()
        session.last_product_candidate = dict(BOOK_A)
        session.commerce_flow_status = STATUS_AWAITING_QUANTITY
        session.awaiting_product_confirmation = True
        session.commerce_pending_candidate = dict(BOOK_A)
        h1 = process_commerce_turn(session, "yeah sure")
        assert "Shall I add one copy" in (h1.force_reply or "")
        h2 = process_commerce_turn(session, "yes")
        assert h2.book_added
        assert get_ledger(session).confirmed_count() == 1

    def test_no_another_book_is_another_request(self):
        session = _session()
        session.commerce_flow_status = STATUS_AWAITING_ANOTHER_BOOK
        hint = process_commerce_turn(session, "No, I need another book")
        assert "isbn" in hint.force_reply.lower() or "title" in hint.force_reply.lower()

    def test_no_thats_all_moves_to_email(self):
        session = _session()
        add_product_candidate(session, title=BOOK_A["title"], isbn=BOOK_A["isbn"],
                              variant_id=BOOK_A["variant_id"], price=BOOK_A["price"])
        confirm_last_candidate(session)
        session.commerce_flow_status = STATUS_AWAITING_ANOTHER_BOOK
        hint = process_commerce_turn(session, "No, that's all")
        assert "email" in hint.force_reply.lower()


class TestEmailConfirmation:
    def test_email_mode_short_circuits_before_openai(self):
        runtime = LLMToolRuntime()
        session = _session()
        add_product_candidate(session, title=BOOK_A["title"], isbn=BOOK_A["isbn"],
                              variant_id=BOOK_A["variant_id"], price=BOOK_A["price"])
        confirm_last_candidate(session)
        session.payment_flow_status = "awaiting_email"

        async def boom(*_a, **_k):
            raise AssertionError("OpenAI must not run")

        runtime._complete = boom  # type: ignore[method-assign]
        sent = []

        async def send(msg):
            sent.append(msg)

        result = asyncio.run(runtime.handle_turn(
            session, f"My email is {EMAIL}", send, assembled_turn_mode="email",
        ))
        assert speak_email(EMAIL) in result.response_text
        assert spell_email_for_voice(EMAIL) in result.response_text
        assert "***" not in result.response_text

    def test_confirmation_includes_full_and_spelled_email(self):
        prompt = confirmation_prompt(EMAIL)
        assert speak_email(EMAIL) in prompt
        assert spell_email_for_voice(EMAIL) in prompt
        assert "***" not in prompt
        assert "gmail" in prompt.lower()
        assert "correct" in prompt.lower()

    def test_spell_email_request_detected(self):
        assert is_email_spell_request("Can you spell my email letter by letter?")

    def test_right_confirms_email(self):
        assert is_email_confirmation("Right")
        assert is_email_confirmation("Yes, that's correct")

    @pytest.mark.asyncio
    async def test_auto_send_uses_session_email_not_arg(self, monkeypatch):
        runtime = LLMToolRuntime()
        session = _session()
        add_product_candidate(session, title=BOOK_A["title"], isbn=BOOK_A["isbn"],
                              variant_id=BOOK_A["variant_id"], price=BOOK_A["price"])
        confirm_last_candidate(session)
        process_payment_turn(session, EMAIL)
        process_payment_turn(session, "yes that's correct")
        assert get_canonical_confirmed_email(session) == EMAIL

        async def fake_send(items, email="", customer_name=None, session=None):
            assert email == EMAIL
            return json.dumps({
                "success": True,
                "email_sent": True,
                "customer_message": PAYMENT_SUCCESS_MESSAGE,
            })

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        sent = []

        async def send(msg):
            sent.append(msg)

        result = await runtime.handle_turn(session, "yes that's correct", send)
        assert "inbox" in result.response_text.lower()

    @pytest.mark.asyncio
    async def test_send_after_confirm_not_no_email(self, monkeypatch):
        session = _session()
        add_product_candidate(session, title=BOOK_A["title"], isbn=BOOK_A["isbn"],
                              variant_id=BOOK_A["variant_id"], price=BOOK_A["price"])
        confirm_last_candidate(session)
        process_payment_turn(session, EMAIL)
        process_payment_turn(session, "right")

        async def fake_send(items, email="", customer_name=None, session=None):
            assert email == EMAIL
            return json.dumps({
                "success": True,
                "email_sent": True,
                "customer_message": PAYMENT_SUCCESS_MESSAGE,
            })

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        out = await llm_tools.dispatch("send_payment_link", {"email": "other@gmail.com"}, session)
        data = json.loads(out)
        assert data.get("error_code") != "no_email"
        assert data.get("success") is True

    def test_create_checkout_gated_before_confirm(self):
        session = _session()
        add_product_candidate(session, title=BOOK_A["title"], isbn=BOOK_A["isbn"],
                              variant_id=BOOK_A["variant_id"], price=BOOK_A["price"])
        confirm_last_candidate(session)
        session.pending_payment_email = EMAIL
        session.awaiting_payment_email_confirmation = True
        gate = gate_tool_call("create_checkout", session)
        assert gate is not None and not gate.allowed

    def test_direct_link_never_spoken(self):
        out = scrub_false_payment_claims("I can provide the direct link for you.")
        assert "direct link" not in out.lower()
        assert "http" not in out.lower()


class TestProgressSends:
    @pytest.mark.asyncio
    async def test_slow_search_sends_conversationrelay_token(self):
        from app.config import Settings

        settings = Settings(OPENAI_API_KEY="test", VOICE_TOOL_PROGRESS_AFTER_MS=100)
        sent: list[dict] = []

        async def send(msg):
            sent.append(msg)

        async def slow_dispatch(name, args, session):
            await asyncio.sleep(0.35)
            return json.dumps({"results": [BOOK_A]})

        await dispatch_with_progress(
            slow_dispatch, "search_products", {"query": "x"}, _session(), send, settings, "CA425",
        )
        tokens = [m.get("token", "") for m in sent if m.get("type") == "text"]
        assert any("catalog" in t.lower() for t in tokens)

    @pytest.mark.asyncio
    async def test_slow_add_to_cart_sends_progress(self):
        from app.config import Settings

        settings = Settings(OPENAI_API_KEY="test", VOICE_TOOL_PROGRESS_AFTER_MS=100)
        sent: list[dict] = []

        async def send(msg):
            sent.append(msg)

        async def slow_dispatch(name, args, session):
            await asyncio.sleep(0.35)
            return json.dumps({"success": True})

        await dispatch_with_progress(
            slow_dispatch, "add_to_cart", {}, _session(), send, settings, "CA425",
        )
        tokens = [m.get("token", "") for m in sent]
        assert any("adding" in t.lower() for t in tokens)

    @pytest.mark.asyncio
    async def test_slow_payment_send_sends_progress(self):
        from app.config import Settings

        settings = Settings(OPENAI_API_KEY="test", VOICE_TOOL_PROGRESS_AFTER_MS=100)
        sent: list[dict] = []

        async def send(msg):
            sent.append(msg)

        async def slow_dispatch(name, args, session):
            await asyncio.sleep(0.35)
            return json.dumps({"success": True})

        await dispatch_with_progress(
            slow_dispatch, "send_payment_link", {}, _session(), send, settings, "CA425",
        )
        tokens = [m.get("token", "") for m in sent]
        assert any("payment" in t.lower() for t in tokens)

    def test_progress_phrases_exist(self):
        assert progress_phrase_for_tool("search_products")
        assert progress_phrase_for_tool("add_to_cart")
        assert progress_phrase_for_tool("send_payment_link")


class TestLiveLogRegression:
    @pytest.mark.asyncio
    async def test_full_two_book_email_payment_flow(self, monkeypatch):
        runtime = LLMToolRuntime()
        session = _session()

        stage_product_candidate(session, BOOK_A)
        process_commerce_turn(session, "Yes")
        process_commerce_turn(session, "yes")
        stage_product_candidate(session, BOOK_B)
        process_commerce_turn(session, "yes that's right")
        process_commerce_turn(session, "yes")
        assert get_ledger(session).confirmed_count() == 2

        done = process_commerce_turn(session, "No, that's all")
        assert "email" in done.force_reply.lower()

        sent = []

        async def send(msg):
            sent.append(msg)

        email_turn = await runtime.handle_turn(
            session, f"Okay. My email address is {EMAIL}.", send, assembled_turn_mode="email",
        )
        assert speak_email(EMAIL) in email_turn.response_text
        assert get_pending_payment_email(session) == EMAIL

        async def fake_send(items, email="", customer_name=None, session=None):
            assert len(items) == 2
            assert email == EMAIL
            return json.dumps({
                "success": True,
                "email_sent": True,
                "customer_message": PAYMENT_SUCCESS_MESSAGE,
            })

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        confirm = await runtime.handle_turn(session, "Yes, that's correct", send)
        assert "inbox" in confirm.response_text.lower()
        assert "http" not in confirm.response_text.lower()
