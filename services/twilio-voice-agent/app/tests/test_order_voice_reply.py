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
            "order_date": "2026-03-10",
            "product_count": 2,
            "payment": {"card_brand": "Visa", "card_last4": "4242"},
            "pricing": {
                "subtotal_before_shipping": "45.00 USD",
                "shipping": "5.99 USD",
                "total": "50.99 USD",
            },
        },
    }
    reply = compose_brief_order_voice_reply(payload)
    assert reply.startswith("I found your order.")
    assert "paid" in reply.lower()
    assert "March 10" in reply
    assert "two products" in reply
    assert "forty five dollars" in reply
    assert "five dollars and ninety nine cents" in reply
    assert "fifty dollars and ninety nine cents" in reply
    assert "4242" in reply
    assert "Visa" in reply
    assert "address" not in reply.lower()


def test_refunded_order_brief_reply():
    inner = {
        "financial_status": "REFUNDED",
        "order_date": "2026-01-15",
        "product_count": 2,
        "customer_name": "Maria Lopez",
        "customer_email": "test@example.com",
        "payment": {"card_brand": "Visa", "card_last4": "4242"},
        "pricing": {
            "subtotal_before_shipping": "45.00 USD",
            "shipping": "5.99 USD",
            "total": "50.99 USD",
        },
        "refunds": [{"reason": "Customer requested cancellation before shipment."}],
        "refund_info": {"refunded": True},
    }
    reply = compose_refunded_order_voice_reply(inner)
    assert "refunded" in reply.lower()
    assert "Maria Lopez" in reply
    assert "refund reason" in reply.lower()
    assert "cancellation before shipment" in reply
    assert "January 15" in reply
    assert "two products" in reply
    assert "forty five dollars" in reply
    assert "test at example dot com" in reply
    assert "4242" in reply
    assert "Visa" in reply
    assert "refund was issued" in reply.lower()
    assert "processing fee" not in reply.lower()


def test_spell_email_letter_by_letter_includes_domain():
    from app.email.speller import spell_email_letter_by_letter

    spelled = spell_email_letter_by_letter("jessica@sureshotbooks.com")
    assert "J-E-S-S-I-C-A" in spelled
    assert "S-U-R-E-S-H-O-T-B-O-O-K-S" in spelled
    assert "C-O-M" in spelled


def test_refunded_order_via_refunds_array_only():
    payload = {
        "found": True,
        "order": {
            "financial_status": "PAID",
            "customer_email": "georgekraemer53@gmail.com",
            "payment": {"card_brand": "American Express", "card_last4": "4004"},
            "refunds": [{"amount": "67.83 USD"}],
            "pricing": {"total": "0.00 USD"},
        },
    }
    reply = compose_brief_order_voice_reply(payload)
    assert "refunded" in reply.lower()


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
