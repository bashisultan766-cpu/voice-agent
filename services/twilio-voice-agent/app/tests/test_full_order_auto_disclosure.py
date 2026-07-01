"""Automatic full order disclosure on lookup — customer only gives order number."""
from __future__ import annotations

from app.voice.order_voice_reply import compose_brief_order_voice_reply, compose_full_order_voice_reply


REFUNDED_ORDER = {
    "found": True,
    "order": {
        "order_number": "39667",
        "financial_status": "REFUNDED",
        "customer_name": "George Kraemer",
        "customer_email": "georgekraemer53@gmail.com",
        "order_date": "2025-07-29",
        "product_count": 1,
        "products": [{
            "title": "Home News Tribune Fri, Sat & Sun 3 Day Delivery For 12 Weeks",
            "quantity": 1,
            "unit_price": "61.87 USD",
        }],
        "pricing": {
            "subtotal": "61.87 USD",
            "shipping": "0.00 USD",
            "total": "0.00 USD",
            "original_total": "67.83 USD",
            "refund_total": "67.83 USD",
        },
        "refunds": [{
            "amount": "67.83 USD",
            "note": "Customer request",
            "refunded_items": ["Home News Tribune Fri, Sat & Sun 3 Day Delivery For 12 Weeks"],
        }],
        "refund_info": {"refunded": True},
        "payment": {"card_brand": "American Express", "card_last4": "4004"},
        "shipping": {"method": "Free Shipping", "fee": "0.00 USD"},
    },
}

PAID_ORDER = {
    "found": True,
    "order": {
        "order_number": "40179",
        "financial_status": "PAID",
        "customer_name": "Jane Doe",
        "customer_email": "jane@example.com",
        "order_date": "2026-03-10",
        "product_count": 2,
        "products": [
            {"title": "Atomic Habits", "quantity": 1, "unit_price": "18.00 USD"},
            {"title": "Deep Work", "quantity": 1, "unit_price": "16.00 USD"},
        ],
        "pricing": {
            "subtotal": "34.00 USD",
            "shipping": "5.99 USD",
            "total": "39.99 USD",
        },
        "payment": {"card_brand": "Visa", "card_last4": "4242"},
        "shipping": {"method": "USPS Media Mail", "fee": "5.99 USD"},
    },
}


def test_refunded_auto_disclosure_includes_everything():
    reply = compose_brief_order_voice_reply(REFUNDED_ORDER)
    lower = reply.lower()
    assert "refunded" in lower
    assert "george kraemer" in lower
    assert "one product" in lower or "you ordered" in lower
    assert "home news tribune" in lower
    assert "free" in lower or "no shipping" in lower
    assert "sixty seven dollars" in lower or "subtotal" in lower
    assert "customer request" in lower
    assert "georgekraemer53 at gmail dot com" in reply
    assert "american express" in lower
    assert "four, zero, zero, four" in reply


def test_paid_auto_disclosure_includes_shipping_and_card():
    reply = compose_brief_order_voice_reply(PAID_ORDER)
    lower = reply.lower()
    assert "paid" in lower
    assert "two products" in lower or "you ordered" in lower
    assert "subtotal" in lower
    assert "shipping" in lower
    assert "total with shipping" in lower
    assert "five dollars and ninety nine cents" in lower
    assert "jane at example dot com" in reply
    assert "visa" in lower
    assert "four, two, four, two" in reply


def test_full_reply_matches_brief_wrapper():
    inner = REFUNDED_ORDER["order"]
    assert compose_full_order_voice_reply(inner) == compose_brief_order_voice_reply(REFUNDED_ORDER)
