"""Regression tests for live call CA5607 — order follow-ups, not robotic replay."""
from __future__ import annotations

from app.agent_runtime.order_flow_state import (
    ORDER_FLOW_VERSION,
    is_order_followup_question,
    try_order_brain_gate,
    try_order_followup_reply,
)
from app.voice.order_voice_reply import (
    compose_order_followup_reply,
    compact_order_snapshot,
    store_order_inner_on_session,
)


ORDER_22958_INNER = {
    "order_number": "22958",
    "financial_status": "REFUNDED",
    "customer_name": "Pat Smith",
    "customer_email": "pat@example.com",
    "product_count": 1,
    "products": [{
        "title": "Arkansas Farm National College Football",
        "quantity": 1,
        "unit_price": "18.52 USD",
        "line_total": "18.52 USD",
    }],
    "pricing": {
        "subtotal": "18.52 USD",
        "shipping": "0.00 USD",
        "total": "0.00 USD",
        "original_total": "20.38 USD",
        "refund_total": "20.38 USD",
    },
    "refunds": [{
        "amount": "20.38 USD",
        "note": "Customer request",
        "refunded_items": ["Arkansas Farm National College Football"],
    }],
    "refund_info": {"refunded": True},
    "payment": {"card_brand": "Visa", "card_last4": "1234"},
    "shipping": {"method": "Free Shipping", "fee": "0.00 USD"},
}


class _Session:
    last_order_number = "22958"
    order_last_voice_reply = "I found your order. This order has been refunded."
    order_context = ""
    commerce_flow_status = "idle"
    order_flow_status = "idle"
    awaiting_anything_else = False


def _session_with_order() -> _Session:
    session = _Session()
    store_order_inner_on_session(session, ORDER_22958_INNER)
    return session


def test_compact_snapshot_roundtrip():
    compact = compact_order_snapshot(ORDER_22958_INNER)
    assert compact["products"][0]["title"].startswith("Arkansas")
    assert compact["pricing"]["shipping"] == "0.00 USD"


def test_shipping_fee_followup_free():
    reply = compose_order_followup_reply(
        ORDER_22958_INNER,
        "Okay. What is the shipping fee?",
    )
    assert reply is not None
    assert "free" in reply.lower() or "no shipping" in reply.lower()


def test_refund_reason_followup():
    reply = compose_order_followup_reply(
        ORDER_22958_INNER,
        "I need information why the order is refunded.",
    )
    assert reply is not None
    assert "customer request" in reply.lower()


def test_reason_only_followup():
    reply = compose_order_followup_reply(ORDER_22958_INNER, "Reason?")
    assert reply is not None
    assert "customer request" in reply.lower()


def test_book_price_followup():
    reply = compose_order_followup_reply(
        ORDER_22958_INNER,
        "What is the price of the book?",
    )
    assert reply is not None
    assert "eighteen dollars" in reply.lower()
    assert "Arkansas" in reply


def test_product_count_followup():
    reply = compose_order_followup_reply(
        ORDER_22958_INNER,
        "How many products are in this order?",
    )
    assert reply is not None
    assert "one product" in reply.lower()


def test_brain_gate_does_not_replay_shipping_question():
    session = _session_with_order()
    gated = try_order_brain_gate(session, "What is the shipping fee?")
    assert gated is not None
    assert "free" in gated.lower() or "no shipping" in gated.lower()
    assert len(gated) < 200


def test_brain_gate_does_not_replay_price_question():
    session = _session_with_order()
    gated = try_order_brain_gate(session, "No. No. I want to know about the price.")
    assert gated is not None
    assert "eighteen dollars" in gated.lower()


def test_try_order_followup_from_session():
    session = _session_with_order()
    reply = try_order_followup_reply(session, "What is the shipping fee?")
    assert reply is not None
    assert "shipping" in reply.lower()


def test_is_order_followup_question():
    assert is_order_followup_question("What is the shipping fee?")
    assert is_order_followup_question("How many products are in this order?")
    assert not is_order_followup_question("Yeah.")


def test_order_flow_version():
    assert ORDER_FLOW_VERSION == "v4.54"
