"""
v4.27 — Multi-email groups, quantity yes=1, yes engagement (no silence).
"""
from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")

from app.agent_runtime.commerce_flow_state import (
    STATUS_AWAITING_QUANTITY,
    process_commerce_turn,
    quantity_prompt,
    stage_product_candidate,
)
from app.agent_runtime.llm_tool_runtime import LLMToolRuntime
from app.agent_runtime.yes_engagement import is_bare_yes, yes_engagement_reply
from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
from app.payment.payment_destination_groups import (
    group_checkout_items,
    try_parse_multi_email_assignment,
)
from app.payment.payment_state_machine import process_payment_turn
from app.pipeline.email_speller import speak_email
from app.state.models import SessionState

BOOKS = [
    {"title": f"Book {i}", "isbn": f"97800000000{i}", "variant_id": f"gid://v/{i}", "price": "9.99"}
    for i in range(1, 6)
]


def _session() -> SessionState:
    return SessionState(
        session_id="v427",
        call_sid="CA_V427",
        from_number="+15551230000",
        to_number="+15559999999",
    )


def _cart_with_books(session: SessionState, n: int = 4) -> None:
    for b in BOOKS[:n]:
        add_product_candidate(session, **b)
        confirm_last_candidate(session)


class TestQuantityYes:
    def test_staged_book_asks_copies(self):
        session = _session()
        stage_product_candidate(session, BOOKS[0])
        assert session.commerce_flow_status == STATUS_AWAITING_QUANTITY
        assert "copies" in quantity_prompt(BOOKS[0]).lower()

    def test_yes_means_one_copy(self):
        session = _session()
        stage_product_candidate(session, BOOKS[0])
        h1 = process_commerce_turn(session, "yes")
        assert "one copy" in (h1.force_reply or "").lower()
        h2 = process_commerce_turn(session, "yes")
        assert h2.book_added
        assert get_ledger(session).confirmed_count() == 1


class TestMultiEmailGroups:
    def test_parse_split_assignment(self):
        session = _session()
        _cart_with_books(session, 4)
        text = (
            "send 2 books to buyer1 at gmail dot com "
            "and the other 2 books to buyer2 at yahoo dot com"
        )
        groups = try_parse_multi_email_assignment(text, session)
        assert groups is not None
        assert len(groups) == 2
        assert len(groups[0]["variant_ids"]) == 2
        assert len(groups[1]["variant_ids"]) == 2
        assert "buyer1@gmail.com" in groups[0]["pending_email"]
        assert "buyer2@yahoo.com" in groups[1]["pending_email"]

    def test_group_checkout_items_subset(self):
        session = _session()
        _cart_with_books(session, 4)
        groups = try_parse_multi_email_assignment(
            "send 2 books to buyer1 at gmail dot com and the other 2 to buyer2 at yahoo dot com",
            session,
        )
        assert groups
        session.payment_destination_groups = groups
        session.active_payment_group_index = 0
        items = group_checkout_items(session)
        assert len(items) == 2

    @pytest.mark.asyncio
    async def test_multi_group_send_engages_next_email(self, monkeypatch):
        from app.agent_runtime import llm_tools
        from app.payment.email_state import get_canonical_confirmed_email

        session = _session()
        _cart_with_books(session, 4)
        groups = try_parse_multi_email_assignment(
            "send 2 books to buyer1 at gmail dot com and the other 2 to buyer2 at yahoo dot com",
            session,
        )
        assert groups
        session.payment_destination_groups = groups
        session.multi_email_payment_active = True
        session.active_payment_group_index = 0

        process_payment_turn(session, "buyer1@gmail.com")
        process_payment_turn(session, "yes that's correct")

        calls = []

        async def fake_send(items, email="", customer_name=None, session=None):
            calls.append({"n": len(items), "email": email})
            return json.dumps({
                "success": True,
                "email_sent": True,
                "customer_message": "I sent the secure payment link to your email. Please check your inbox and spam folder.",
            })

        monkeypatch.setattr(llm_tools._st, "SendPaymentLink", fake_send)
        out = await llm_tools.dispatch("send_payment_link", {}, session)
        data = json.loads(out)
        assert data["success"] is True
        assert calls[0]["n"] == 2
        assert calls[0]["email"] == "buyer1@gmail.com"
        assert "next" in data["customer_message"].lower() or "yahoo" in data["customer_message"].lower()


class TestYesEngagement:
    def test_bare_yes_at_email_collection_gets_prompt(self):
        session = _session()
        _cart_with_books(session, 1)
        session.commerce_flow_status = "awaiting_email_collection"
        session.awaiting_payment_email = True
        assert is_bare_yes("yes")
        reply = yes_engagement_reply(session)
        assert reply
        assert "email" in reply.lower()

    @pytest.mark.asyncio
    async def test_bare_yes_does_not_fall_through_silent(self):
        runtime = LLMToolRuntime()
        session = _session()
        _cart_with_books(session, 1)
        session.awaiting_payment_email = True
        session.payment_flow_status = "awaiting_email"

        async def boom(*_a, **_k):
            raise AssertionError("OpenAI must not run on bare yes")

        runtime._complete = boom  # type: ignore[method-assign]

        async def send(msg):
            pass

        result = await runtime.handle_turn(session, "yes", send)
        assert result.response_text
        assert "email" in result.response_text.lower()
