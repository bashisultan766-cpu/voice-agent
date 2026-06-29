"""Tests for brief natural order voice replies."""
from __future__ import annotations

from app.voice.money_speech import speak_money_field, speak_usd_amount
from app.voice.order_voice_reply import (
    compose_brief_order_voice_reply,
    compose_refunded_order_voice_reply,
)


def test_speak_usd_amount_natural():
    assert speak_usd_amount(90.99) == "ninety dollars and ninety nine cents"
    assert speak_usd_amount(18.0) == "eighteen dollars"
    assert speak_usd_amount(1.01) == "one dollar and one cent"


def test_speak_money_field_parses_shopify_pricing():
    assert "eighteen dollars" in speak_money_field("18.52 USD")


def test_brief_order_found_reply():
    payload = {
        "found": True,
        "order": {
            "financial_status": "PAID",
            "product_count": 2,
            "pricing": {
                "subtotal_before_shipping": "45.00 USD",
                "shipping": "5.99 USD",
                "total": "50.99 USD",
            },
        },
    }
    reply = compose_brief_order_voice_reply(payload)
    assert reply.startswith("I found your order.")
    assert "two products" in reply
    assert "forty five dollars" in reply
    assert "five dollars and ninety nine cents" in reply
    assert "fifty dollars and ninety nine cents" in reply
    assert "address" not in reply.lower()


def test_refunded_order_brief_reply():
    inner = {
        "financial_status": "REFUNDED",
        "customer_email": "test@example.com",
        "payment": {"card_brand": "Visa", "card_last4": "4242"},
        "refund_info": {"refunded": True},
    }
    reply = compose_refunded_order_voice_reply(inner)
    assert "refunded" in reply.lower()
    assert "test at example dot com" in reply
    assert "4242" in reply
    assert "Visa" in reply


def test_order_enrichment_skips_isbn_turn_mode():
    from app.agent_runtime.order_flow_state import _should_skip_order_lookup

    class _Session:
        pending_isbn_buffer = ""
        commerce_flow_status = "awaiting_another_book"

    assert _should_skip_order_lookup(
        "The ISBN number of second book is 9780553263572.",
        _Session(),
        turn_mode="isbn",
    )


def test_extract_order_number_none_on_isbn_turn():
    from app.agent_runtime.order_flow_state import extract_order_number

    class _Session:
        pending_isbn_buffer = ""
        commerce_flow_status = "idle"

    assert extract_order_number(
        "9780553263572.",
        _Session(),
        turn_mode="isbn",
    ) is None
