"""
v4.29 — Cart memory for payment send + fast greeting.

Fixes stale payment_destination_groups causing empty checkout at send time.
"""
from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("RESEND_API_KEY", "re_test")
os.environ.setdefault("RESEND_FROM_EMAIL", "orders@example.com")

from app.agent_runtime.fast_greeting import fast_greeting_reply, is_fast_greeting_turn
from app.agent_runtime.llm_tool_runtime import LLMToolRuntime
from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
from app.payment.email_state import confirm_payment_email, set_pending_payment_email
from app.payment.payment_destination_groups import (
    ensure_payment_groups,
    group_checkout_items,
    init_single_group_from_cart,
    refresh_payment_groups_from_cart,
)
from app.payment.payment_link_service import send_confirmed_payment_link
from app.state.models import SessionState

EMAIL = "buyer@gmail.com"


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="v429",
        call_sid="CA_V429001",
        from_number="+15551230000",
        to_number="+15559999999",
        twiml_greeting_spoken=True,
        **kwargs,
    )


def _add_book(session: SessionState, idx: int, qty: int = 1) -> None:
    add_product_candidate(
        session,
        title=f"Book {idx}",
        isbn=f"97800000000{idx:02d}",
        variant_id=f"gid://shopify/ProductVariant/{idx}",
        price="10.00",
        quantity=qty,
    )
    confirm_last_candidate(session)


class TestStalePaymentGroups:
    def test_stale_group_refreshes_when_second_book_added(self):
        session = _session()
        _add_book(session, 1)
        init_single_group_from_cart(session)
        assert len(session.payment_destination_groups[0]["variant_ids"]) == 1

        _add_book(session, 2, qty=2)
        refresh_payment_groups_from_cart(session)
        assert len(session.payment_destination_groups[0]["variant_ids"]) == 2

        items = group_checkout_items(session)
        assert len(items) == 2
        assert sum(i["quantity"] for i in items) == 3

    def test_empty_stale_group_falls_back_to_full_cart(self):
        session = _session()
        _add_book(session, 1)
        _add_book(session, 2)
        session.payment_destination_groups = [{
            "group_id": "stale",
            "variant_ids": [],
            "titles": [],
            "pending_email": "",
            "confirmed_email": "",
            "email_confirmed": False,
            "awaiting_email_confirmation": False,
            "checkout_url": "",
            "payment_link_sent": False,
        }]
        items = group_checkout_items(session)
        assert len(items) == 2

    @pytest.mark.asyncio
    async def test_send_uses_refreshed_cart_lines(self):
        session = _session()
        _add_book(session, 1, qty=2)
        init_single_group_from_cart(session)
        _add_book(session, 2, qty=2)
        set_pending_payment_email(session, EMAIL)
        confirm_payment_email(session)

        ok = json.dumps({"success": True, "email_sent": True, "customer_message": "sent"})
        with patch("app.tools.shopify_tools.SendPaymentLink", new_callable=AsyncMock) as mock_send:
            mock_send.return_value = ok
            result = await send_confirmed_payment_link(session)

        assert result.get("success")
        call_items = mock_send.call_args.kwargs.get("items") or mock_send.call_args[1].get("items")
        assert len(call_items) == 2
        assert sum(int(i["quantity"]) for i in call_items) == 4


class TestFastGreeting:
    def test_hello_is_greeting(self):
        assert is_fast_greeting_turn("hello how are you brother", turn_count=0)

    def test_fast_reply_skips_llm_tone(self):
        session = _session()
        reply = fast_greeting_reply(session, "how are you brother")
        assert reply
        assert "doing well" in reply.lower()

    @pytest.mark.asyncio
    async def test_runtime_short_circuits_greeting(self):
        session = _session()
        send_fn = AsyncMock()
        runtime = LLMToolRuntime()
        with patch.object(runtime, "_run_tool_loop", new_callable=AsyncMock) as mock_loop:
            await runtime.handle_turn(session, "hello how are you", send_fn)
            mock_loop.assert_not_called()
        assert send_fn.await_count >= 1
