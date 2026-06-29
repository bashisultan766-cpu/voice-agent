"""Call hangup, memory, and multi-copy regression tests."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
from app.dialogue.call_closure import caller_wants_to_end, process_call_closure_turn
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="s1",
        call_sid="CA_HANGUP_001",
        from_number="+15551234567",
        to_number="+15559876543",
    )
    base.update(kwargs)
    return SessionState(**base)


class TestCallClosureGoodbye:
    def test_see_you_next_time_ends_after_payment(self):
        session = _session(payment_link_sent=True)
        result = process_call_closure_turn(session, "No. No. Thank you. See you next time.")
        assert result is not None
        assert result.end_call is True

    def test_caller_wants_to_end_bye_bye(self):
        assert caller_wants_to_end("Okay. Thank you. See you. Bye bye.") is True

    def test_caller_wants_to_end_cut_call(self):
        assert caller_wants_to_end("Can you cut the call?") is True

    def test_no_thats_all_loose_match(self):
        session = _session(awaiting_anything_else=True)
        result = process_call_closure_turn(session, "No, that's all")
        assert result is not None
        assert result.end_call is True


class TestAddToCartPendingQuantity:
    @pytest.mark.asyncio
    async def test_add_to_cart_uses_commerce_pending_quantity(self):
        from app.agent_runtime.llm_tools import AddToCartArgs, _add_to_cart

        session = _session(commerce_pending_quantity=3)
        add_product_candidate(
            session,
            title="Test Book",
            isbn="9780000000001",
            variant_id="v1",
            price="9.99",
            quantity=1,
        )
        session.commerce_pending_candidate = {
            "title": "Test Book",
            "isbn": "9780000000001",
            "variant_id": "v1",
            "price": "9.99",
        }
        raw = await _add_to_cart(
            AddToCartArgs(title="Test Book", isbn="9780000000001", variant_id="v1"),
            session,
        )
        payload = json.loads(raw)
        assert payload["success"] is True
        confirmed = get_ledger(session).confirmed_items
        assert len(confirmed) == 1
        assert confirmed[0].quantity == 3


class TestCallMemoryRichCart:
    def test_sync_from_session_records_copy_counts(self):
        from app.conversation.call_memory import get_call_memory, sync_from_session

        session = _session()
        add_product_candidate(
            session, title="Book A", isbn="9780000000001", variant_id="v1", quantity=2,
        )
        confirm_last_candidate(session)
        sync_from_session(session)
        mem = get_call_memory(session)
        assert any("2 copies" in f for f in mem.important_facts)


class TestConversationRelayEndMessage:
    @pytest.mark.asyncio
    async def test_send_routes_end_to_queue_not_outbound(self):
        from app.ws.conversation_relay_sender import ConversationRelayOutbound, ConversationRelayStats

        queued: list[dict] = []

        async def queue_send(msg: dict) -> None:
            queued.append(msg)

        outbound = ConversationRelayOutbound(
            queue_send, MagicMock(), "CAtest01", ConversationRelayStats(),
        )
        outbound.engine_send = AsyncMock()

        async def send(msg: dict) -> None:
            if msg.get("type") == "end":
                await queue_send(msg)
                return
            await outbound.engine_send(msg)

        await send({"type": "end", "handoffData": '{"reason":"caller_done"}'})
        assert len(queued) == 1
        assert queued[0]["type"] == "end"
        outbound.engine_send.assert_not_called()
