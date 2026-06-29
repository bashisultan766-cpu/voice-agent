"""Regression tests for live order #39667 and related voice order flows."""
from __future__ import annotations

import asyncio

import pytest

from app.agent_runtime.order_flow_state import (
    _should_skip_order_lookup,
    extract_order_number,
    is_actionable_order_number,
    order_intent_detected,
    try_another_order_short_circuit,
    try_order_collection_short_circuit,
    try_order_followup_reply,
    try_order_hold_reply,
    try_order_repeat_reply,
    try_order_brain_gate,
    ORDER_FLOW_VERSION,
)
from app.runtime.fast_classifier import classify
from app.voice.order_voice_reply import compose_brief_order_voice_reply
from app.voice.turn_assembler import TurnAssembler


ORDER_39667_PAYLOAD = {
    "found": True,
    "order": {
        "order_number": "39667",
        "financial_status": "REFUNDED",
        "product_count": 0,
        "customer_email": "georgekraemer53@gmail.com",
        "payment": {
            "card_brand": "American Express",
            "card_last4": "4004",
        },
        "pricing": {
            "subtotal_before_shipping": "0.00 USD",
            "shipping": "0.00 USD",
            "total": "0.00 USD",
        },
        "refund_info": {"refunded": True},
        "refunds": [{"amount": "67.83 USD"}],
    },
}


class _Session:
    last_order_number = ""
    order_last_voice_reply = ""
    order_context = ""
    pending_order_number = ""
    pending_isbn_buffer = ""
    commerce_flow_status = "idle"
    order_flow_status = "idle"


def test_order_39667_refunded_brief_reply():
    reply = compose_brief_order_voice_reply(ORDER_39667_PAYLOAD)
    assert "refunded" in reply.lower()
    assert "georgekraemer53 at gmail dot com" in reply
    assert "four, zero, zero, four" in reply
    assert "American Express" in reply
    assert len(reply) < 400
    assert "address" not in reply.lower()
    assert "Home News Tribune" not in reply


def test_looking_for_order_intent():
    assert order_intent_detected("I'm looking for order.")
    result = classify("I'm looking for order.", _Session())
    assert result.is_order_lookup
    assert not result.is_product_search


def test_nine_digit_isbn_chunk_skips_order_lookup():
    session = _Session()
    session.pending_isbn_buffer = "9780"
    assert _should_skip_order_lookup("552579901.", session, turn_mode="order")


def test_isbn_permission_phrase():
    from app.voice.turn_taking import is_isbn_permission_question

    assert is_isbn_permission_question("I will give you the ISBN number.")


def test_order_info_intent_not_product_search():
    text = "I need information about the order."
    assert order_intent_detected(text)
    result = classify(text, _Session())
    assert result.is_order_lookup
    assert result.reason == "order_lookup"
    assert not result.is_product_search


def test_hello_plus_order_info_collection():
    session = _Session()
    hint = try_order_collection_short_circuit(
        session,
        "Hello. I need information about order.",
    )
    assert hint is not None
    assert "order number" in hint.force_reply.lower()


def test_order_collection_short_circuit():
    session = _Session()
    hint = try_order_collection_short_circuit(
        session,
        "I need information about the order.",
    )
    assert hint is not None
    assert hint.force_reply
    assert "order number" in hint.force_reply.lower()
    assert session.order_flow_status == "awaiting_order_number"


def test_repeat_order_number_from_session():
    session = _Session()
    session.last_order_number = "39667"
    reply = try_order_repeat_reply(session, "Can you repeat the order number?")
    assert reply is not None
    assert "3 9 6 6 7" in reply


def test_repeat_order_summary_from_memory():
    session = _Session()
    session.order_last_voice_reply = (
        "I found your order. The order status is refunded."
    )
    reply = try_order_repeat_reply(session, "Can you repeat what you have?")
    assert reply == session.order_last_voice_reply


def test_what_replays_last_order_summary():
    session = _Session()
    session.order_last_voice_reply = "I found your order 38873."
    reply = try_order_repeat_reply(session, "What?")
    assert reply == session.order_last_voice_reply


def test_order_confirm_replays_last_summary():
    session = _Session()
    session.order_last_voice_reply = "I found your order 38873."
    reply = try_order_repeat_reply(session, "Yes. This is the correct order number.")
    assert reply == session.order_last_voice_reply


def test_bare_four_digits_not_actionable():
    assert extract_order_number("3 8 8 7.", _Session()) is None
    assert not is_actionable_order_number("3887")


def test_five_digit_order_is_actionable():
    assert extract_order_number("38873.", _Session()) == "38873"
    assert is_actionable_order_number("38873")


def test_order_number_preamble_short_circuit():
    session = _Session()
    hint = try_order_collection_short_circuit(session, "order number is")
    assert hint is not None
    assert "listening" in hint.force_reply.lower()
    assert session.order_flow_status == "awaiting_order_number"


def test_partial_order_speech_merges_before_lookup():
    session = _Session()
    # Spoken partial still parses as 3966; turn assembler debounces before lookup.
    assert extract_order_number("No. No. The order number is 3 9 6 6", session) == "3966"
    assert extract_order_number(
        "No. No. The order number is 3 9 6 6 7.",
        session,
    ) == "39667"


@pytest.mark.asyncio
async def test_turn_assembler_merges_trailing_order_digit():
    emitted: list[tuple[str, str]] = []

    async def on_emit(turn):
        emitted.append((turn.text, turn.mode))

    asm = TurnAssembler()
    asm._settings.VOICE_ORDER_COLLECTION_SILENCE_MS = 80

    held1 = await asm.ingest(
        "No. No. The order number is 3 9 6 6",
        on_emit,
        call_sid="CAtest1",
    )
    assert held1 is True
    assert asm._state.mode == "order"

    held2 = await asm.ingest("7.", on_emit, call_sid="CAtest1")
    assert held2 is True

    await asyncio.sleep(0.15)

    assert len(emitted) == 1
    text, mode = emitted[0]
    assert mode == "order"
    assert extract_order_number(text, _Session()) == "39667"


@pytest.mark.asyncio
async def test_turn_assembler_holds_bare_four_digit_order():
    emitted: list[tuple[str, str]] = []

    async def on_emit(turn):
        emitted.append((turn.text, turn.mode))

    asm = TurnAssembler()
    asm._settings.VOICE_ORDER_COLLECTION_SILENCE_MS = 80

    held = await asm.ingest("3 8 8 7.", on_emit, call_sid="CAtest2")
    assert held is True
    assert asm._state.mode == "order"
    await asyncio.sleep(0.15)
    assert emitted == []

    held2 = await asm.ingest("3.", on_emit, call_sid="CAtest2")
    assert held2 is True
    await asyncio.sleep(0.15)
    assert len(emitted) == 1
    text, mode = emitted[0]
    assert mode == "order"
    assert extract_order_number(text, _Session()) == "38873"


def test_other_order_intent():
    assert order_intent_detected("I want information about the other order.")


def test_another_order_short_circuit():
    session = _Session()
    session.last_order_number = "41635"
    session.order_last_voice_reply = "I found your order 41635."
    hint = try_another_order_short_circuit(session, "Yeah. I want information about the other order.")
    assert hint is not None
    assert "other order number" in hint.force_reply.lower()
    assert session.order_flow_status == "awaiting_order_number"


def test_hold_during_order_collection():
    session = _Session()
    session.order_flow_status = "awaiting_order_number"
    reply = try_order_hold_reply(session, "Okay. Just hold a second.")
    assert reply is not None
    assert "take your time" in reply.lower()


def test_order_dispute_replays_shopify_template():
    session = _Session()
    session.order_last_voice_reply = "I found your order. Status is paid."
    reply = try_order_repeat_reply(session, "Your detail is not correct.")
    assert reply == session.order_last_voice_reply


def test_order_brain_gate_blocks_dispute_reformat():
    session = _Session()
    session.order_last_voice_reply = "I found your order 40179. Two books."
    session.last_order_number = "40179"
    gated = try_order_brain_gate(session, "You are giving the wrong information.")
    assert gated == session.order_last_voice_reply


def test_order_flow_version():
    assert ORDER_FLOW_VERSION == "v4.43"


def test_buy_book_does_not_replay_order_summary():
    session = _Session()
    session.order_last_voice_reply = "I found your order 39787."
    session.last_order_number = "39787"
    assert try_order_repeat_reply(
        session,
        "What's the process to buy a book from your shop?",
    ) is None
    assert try_order_brain_gate(
        session,
        "Now I want to buy a books from you. What's the process?",
    ) is None


def test_card_followup_uses_cached_order():
    session = _Session()
    session.last_order_number = "39787"
    session.order_context = (
        '{"payment": {"card_brand": "Visa", "card_last4": "1234"}, '
        '"financial_status": "PAID"}'
    )
    reply = try_order_followup_reply(session, "The credit card last 4 digits?")
    assert reply is not None
    assert "one, two, three, four" in reply


def test_hold_just_second():
    session = _Session()
    session.order_flow_status = "awaiting_order_number"
    reply = try_order_hold_reply(session, "Just second.")
    assert reply is not None
