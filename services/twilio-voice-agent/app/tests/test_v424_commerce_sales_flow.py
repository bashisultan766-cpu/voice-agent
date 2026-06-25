"""
v4.24 — Multi-book commerce sales flow + slow-tool progress prompts.

Covers:
  * Progress phrase during slow catalog search (no silence)
  * Confirm each book before add_to_cart
  * Another-book prompt after each add
  * No → cart summary + email collection
  * Email short-circuit regression (v4.23)
  * Single checkout for all cart items on payment send
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
    STATUS_AWAITING_EMAIL_COLLECTION,
    another_book_after_add_prompt,
    confirm_book_prompt,
    process_commerce_turn,
    stage_product_candidate,
)
from app.agent_runtime.llm_tool_runtime import LLMToolRuntime
from app.agent_runtime.payment_flow_state import PAYMENT_SUCCESS_MESSAGE
from app.agent_runtime.tool_progress import dispatch_with_progress, progress_phrase_for_tool
from app.agent_runtime.tool_runtime_gates import gate_tool_call
from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
from app.pipeline.email_speller import speak_email, spell_email_for_voice
from app.state.models import SessionState


BOOK_A = {
    "title": "100,000 and Freedom Too",
    "isbn": "9780997361308",
    "variant_id": "gid://shopify/ProductVariant/a",
    "price": "$16.23",
    "available": True,
}
BOOK_B = {
    "title": "Hater",
    "isbn": "9781938857669",
    "variant_id": "gid://shopify/ProductVariant/b",
    "price": "$34.65",
    "available": True,
}


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="v424",
        call_sid="CA_V424001",
        from_number="+15551230000",
        to_number="+15559999999",
        **kwargs,
    )


class TestSlowToolProgress:
    @pytest.mark.asyncio
    async def test_progress_phrase_after_delay(self):
        from app.config import Settings

        settings = Settings(OPENAI_API_KEY="test", VOICE_TOOL_PROGRESS_AFTER_MS=100)
        sent: list[dict] = []

        async def send(msg):
            sent.append(msg)

        async def slow_dispatch(name, args, session):
            await asyncio.sleep(0.35)
            return json.dumps({"results": [BOOK_A]})

        result = await dispatch_with_progress(
            slow_dispatch,
            "search_products",
            {"query": "freedom"},
            _session(),
            send,
            settings,
            "CA424",
        )
        assert json.loads(result)["results"]
        progress_tokens = [m["token"] for m in sent if m.get("token")]
        assert any("catalog" in t.lower() or "moment" in t.lower() for t in progress_tokens)

    def test_slow_tools_have_phrases(self):
        assert progress_phrase_for_tool("search_products")
        assert progress_phrase_for_tool("catalog_search")


class TestBookConfirmBeforeAdd:
    def test_search_stages_candidate(self):
        session = _session()
        stage_product_candidate(session, BOOK_A)
        assert session.commerce_flow_status == STATUS_AWAITING_QUANTITY
        assert session.commerce_pending_candidate["title"] == BOOK_A["title"]

    def test_add_to_cart_blocked_until_confirm(self):
        session = _session()
        stage_product_candidate(session, BOOK_A)
        gate = gate_tool_call("add_to_cart", session)
        assert gate is not None and not gate.allowed
        assert gate.reason == "book_not_confirmed"

    @pytest.mark.asyncio
    async def test_dispatch_add_blocked_with_confirm_message(self):
        session = _session()
        stage_product_candidate(session, BOOK_A)
        out = await llm_tools.dispatch(
            "add_to_cart",
            {"title": BOOK_A["title"], "variant_id": BOOK_A["variant_id"]},
            session,
        )
        data = json.loads(out)
        assert data["success"] is False
        assert data["error_code"] == "book_not_confirmed"
        assert BOOK_A["title"] in data["customer_message"]
        assert get_ledger(session).confirmed_count() == 0


def _yes_add_staged(session):
    process_commerce_turn(session, "yes")
    return process_commerce_turn(session, "yes")


class TestMultiBookFlow:
    def test_yes_confirms_and_asks_another(self):
        session = _session()
        stage_product_candidate(session, BOOK_A)
        hint = _yes_add_staged(session)
        assert hint.force_reply
        assert hint.book_added
        assert "another book" in hint.force_reply.lower()
        assert get_ledger(session).confirmed_count() == 1
        assert session.commerce_flow_status == STATUS_AWAITING_ANOTHER_BOOK

    def test_no_after_add_summarizes_and_collects_email(self):
        session = _session()
        add_product_candidate(session, **{k: BOOK_A[k] for k in ("title", "isbn", "variant_id", "price")})
        confirm_last_candidate(session)
        session.commerce_flow_status = STATUS_AWAITING_ANOTHER_BOOK
        hint = process_commerce_turn(session, "no")
        assert hint.force_reply
        assert BOOK_A["title"] in hint.force_reply
        assert "email" in hint.force_reply.lower()
        assert session.commerce_flow_status == STATUS_AWAITING_EMAIL_COLLECTION
        assert session.payment_flow_status == "awaiting_email"

    def test_yes_to_another_prompts_for_next_book(self):
        session = _session()
        session.commerce_flow_status = STATUS_AWAITING_ANOTHER_BOOK
        hint = process_commerce_turn(session, "yes")
        assert hint.force_reply
        assert "isbn" in hint.force_reply.lower() or "title" in hint.force_reply.lower()

    def test_confirm_prompt_text(self):
        prompt = confirm_book_prompt(BOOK_A)
        assert BOOK_A["title"] in prompt
        assert "copies" in prompt.lower()


class TestRuntimeCommerceIntegration:
    @pytest.mark.asyncio
    async def test_search_turn_returns_confirm_not_add(self, monkeypatch):
        from dataclasses import dataclass, field

        @dataclass
        class _Fn:
            name: str
            arguments: str

        @dataclass
        class _TC:
            id: str
            function: _Fn
            type: str = "function"

        @dataclass
        class _Msg:
            content: str | None = None
            tool_calls: list | None = None

        @dataclass
        class _Choice:
            message: _Msg

        @dataclass
        class _Resp:
            choices: list

        runtime = LLMToolRuntime()
        session = _session()
        search_payload = json.dumps({"results": [BOOK_A], "count": 1})
        call_n = {"n": 0}

        async def fake_complete(messages, sid):
            call_n["n"] += 1
            if call_n["n"] == 1:
                return _Resp(choices=[_Choice(_Msg(
                    content=None,
                    tool_calls=[_TC(id="tc1", function=_Fn(
                        name="search_products",
                        arguments='{"query":"freedom"}',
                    ))],
                ))])
            return _Resp(choices=[_Choice(_Msg(content="Adding it now."))])

        monkeypatch.setattr(runtime, "_complete", fake_complete)
        monkeypatch.setattr(
            llm_tools._st,
            "search_products",
            AsyncMock(return_value=search_payload),
        )

        sent: list[dict] = []

        async def send(msg):
            sent.append(msg)

        result = await runtime.handle_turn(session, "I'm looking for Freedom Too", send)
        assert BOOK_A["title"] in result.response_text
        assert "copies" in result.response_text.lower()
        assert get_ledger(session).confirmed_count() == 0


class TestEmailShortCircuitRegression:
    @pytest.mark.asyncio
    async def test_email_turn_still_skips_openai(self):
        runtime = LLMToolRuntime()
        session = _session()
        add_product_candidate(session, title=BOOK_A["title"], isbn=BOOK_A["isbn"],
                              variant_id=BOOK_A["variant_id"], price=BOOK_A["price"])
        confirm_last_candidate(session)
        session.payment_flow_status = "awaiting_email"
        session.commerce_flow_status = STATUS_AWAITING_EMAIL_COLLECTION

        openai_called = []

        async def fake_complete(*_a, **_k):
            openai_called.append(1)
            raise AssertionError("OpenAI must not run")

        runtime._complete = fake_complete  # type: ignore[method-assign]
        sent = []

        async def send(msg):
            sent.append(msg)

        utterance = "Okay. My email address is bashisultan766@gmail.com."
        result = await runtime.handle_turn(session, utterance, send, assembled_turn_mode="email")
        assert not openai_called
        assert speak_email("bashisultan766@gmail.com") in result.response_text
        assert spell_email_for_voice("bashisultan766@gmail.com") in result.response_text
        assert "correct" in result.response_text.lower()


class TestFullTwoBookPaymentFlow:
    @pytest.mark.asyncio
    async def test_two_books_email_confirm_single_checkout(self, monkeypatch):
        runtime = LLMToolRuntime()
        session = _session()

        # Book 1
        stage_product_candidate(session, BOOK_A)
        h1 = _yes_add_staged(session)
        assert h1.book_added
        assert session.commerce_flow_status == STATUS_AWAITING_ANOTHER_BOOK

        # Want another
        process_commerce_turn(session, "yes")

        # Book 2 staged + confirmed
        stage_product_candidate(session, BOOK_B)
        process_commerce_turn(session, "yes that's right")
        h2 = process_commerce_turn(session, "yes")
        assert h2.book_added
        assert get_ledger(session).confirmed_count() == 2

        # Done shopping
        h3 = process_commerce_turn(session, "no")
        assert "email" in h3.force_reply.lower()
        assert BOOK_A["title"] in h3.force_reply
        assert BOOK_B["title"] in h3.force_reply

        # Email capture
        sent = []

        async def send(msg):
            sent.append(msg)

        email_result = await runtime.handle_turn(
            session,
            "bashisultan766@gmail.com",
            send,
            assembled_turn_mode="email",
        )
        assert speak_email("bashisultan766@gmail.com") in email_result.response_text

        checkout_calls: list[dict] = []

        async def fake_send(items, email="", customer_name=None, session=None):
            checkout_calls.append({"items": items, "email": email})
            return json.dumps({
                "success": True,
                "email_sent": True,
                "customer_message": PAYMENT_SUCCESS_MESSAGE,
            })

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)

        confirm_result = await runtime.handle_turn(session, "yes that's correct", send)
        assert checkout_calls
        assert len(checkout_calls[0]["items"]) == 2
        assert checkout_calls[0]["email"] == "bashisultan766@gmail.com"
        assert "inbox" in confirm_result.response_text.lower()
