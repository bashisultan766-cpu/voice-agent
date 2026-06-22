"""
Tests for app/pipeline/router.py — deterministic intent and entity detection.

Covers all 13 intents, entity extraction, edge cases, and session-less calls.
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.pipeline.router import detect, IntentResult
from app.pipeline.tasks import Intent


# ── ISBN search ───────────────────────────────────────────────────────────────

class TestIsbnSearch:
    def test_explicit_isbn_prefix(self):
        r = detect("isbn 9780306406157")
        assert r.intent == Intent.ISBN_SEARCH
        assert r.confidence >= 0.9
        assert "isbn" in r.entities

    def test_isbn_keyword_only(self):
        r = detect("I'm looking for ISBN 0306406152")
        assert r.intent == Intent.ISBN_SEARCH

    def test_bare_13_digit_isbn(self):
        r = detect("9780306406157")
        assert r.intent == Intent.ISBN_SEARCH
        assert r.entities.get("isbn")

    def test_isbn_needs_filler(self):
        r = detect("isbn 9780306406157")
        assert r.needs_filler is True
        assert "search_products" in r.suggested_tools


# ── Refund status ─────────────────────────────────────────────────────────────

class TestRefundStatus:
    def test_refund_keyword(self):
        r = detect("I want a refund on my order")
        assert r.intent == Intent.REFUND_STATUS
        assert r.confidence >= 0.85

    def test_money_back(self):
        r = detect("I want my money back please")
        assert r.intent == Intent.REFUND_STATUS

    def test_return_item(self):
        r = detect("I'd like to return this book")
        assert r.intent == Intent.REFUND_STATUS

    def test_refund_precedes_order(self):
        r = detect("What's my refund status for order 1234?")
        assert r.intent == Intent.REFUND_STATUS


# ── Order lookup ─────────────────────────────────────────────────────────────

class TestOrderLookup:
    def test_order_keyword(self):
        r = detect("Where is my order?")
        assert r.intent == Intent.ORDER_LOOKUP

    def test_tracking_keyword(self):
        r = detect("Can you track my package?")
        assert r.intent == Intent.ORDER_LOOKUP

    def test_order_number_extracted(self):
        r = detect("What's the status of order 1042?")
        assert r.intent == Intent.ORDER_LOOKUP
        assert r.entities.get("order_number") == "#1042"

    def test_order_needs_filler(self):
        r = detect("where is my order")
        assert r.needs_filler is True


# ── Escalation ────────────────────────────────────────────────────────────────

class TestEscalation:
    def test_human_keyword(self):
        r = detect("I want to speak to a human")
        assert r.intent == Intent.ESCALATION

    def test_manager_keyword(self):
        r = detect("Can I talk to a manager?")
        assert r.intent == Intent.ESCALATION

    def test_live_agent(self):
        r = detect("Connect me to a live agent")
        assert r.intent == Intent.ESCALATION

    def test_escalation_no_filler(self):
        r = detect("I want a human")
        assert r.needs_filler is False
        assert "escalate_to_human" in r.suggested_tools


# ── Checkout request ──────────────────────────────────────────────────────────

class TestCheckoutRequest:
    def test_buy_keyword(self):
        r = detect("I want to buy that book")
        assert r.intent == Intent.CHECKOUT_REQUEST

    def test_purchase(self):
        r = detect("I'd like to purchase it please")
        assert r.intent == Intent.CHECKOUT_REQUEST

    def test_checkout_needs_filler(self):
        r = detect("checkout please")
        assert r.needs_filler is True


# ── Send payment link ─────────────────────────────────────────────────────────

class TestSendPaymentLink:
    def test_email_link(self):
        r = detect("Can you email me the payment link?")
        assert r.intent == Intent.SEND_PAYMENT_LINK

    def test_send_link(self):
        r = detect("send me the link")
        assert r.intent == Intent.SEND_PAYMENT_LINK

    def test_send_link_no_filler(self):
        r = detect("send me the link please")
        assert r.needs_filler is False


# ── Product search ────────────────────────────────────────────────────────────

class TestProductSearch:
    def test_do_you_have(self):
        r = detect("Do you have any books by Stephen King?")
        # Could be author_search or product_search — both are valid
        assert r.intent in (Intent.PRODUCT_SEARCH, Intent.AUTHOR_SEARCH)

    def test_looking_for(self):
        r = detect("I'm looking for a mystery novel")
        assert r.intent == Intent.PRODUCT_SEARCH

    def test_product_phrase_extracted(self):
        r = detect("Do you have a copy of Dune?")
        assert r.intent == Intent.PRODUCT_SEARCH
        assert r.entities.get("product_phrase")

    def test_product_search_needs_filler(self):
        r = detect("do you have any thrillers in stock")
        assert r.needs_filler is True


# ── Author search ─────────────────────────────────────────────────────────────

class TestAuthorSearch:
    def test_by_author(self):
        r = detect("books by George Orwell")
        assert r.intent == Intent.AUTHOR_SEARCH

    def test_written_by(self):
        r = detect("anything written by Hemingway")
        assert r.intent == Intent.AUTHOR_SEARCH

    def test_author_needs_filler(self):
        r = detect("books by Neil Gaiman")
        assert r.needs_filler is True
        assert "search_products" in r.suggested_tools


# ── Greeting ──────────────────────────────────────────────────────────────────

class TestGreeting:
    def test_hello(self):
        r = detect("Hello")
        assert r.intent == Intent.GREETING
        assert r.needs_filler is False

    def test_hey(self):
        r = detect("Hey there")
        assert r.intent == Intent.GREETING

    def test_good_morning(self):
        r = detect("Good morning!")
        assert r.intent == Intent.GREETING


# ── Confirmation ──────────────────────────────────────────────────────────────

class TestConfirmation:
    def test_yes(self):
        r = detect("yes")
        assert r.intent == Intent.CONFIRMATION
        assert r.entities.get("polarity") == "yes"

    def test_no(self):
        r = detect("no thanks")
        assert r.intent == Intent.CONFIRMATION
        assert r.entities.get("polarity") == "no"

    def test_yeah(self):
        r = detect("yeah")
        assert r.intent == Intent.CONFIRMATION

    def test_nope(self):
        r = detect("nope")
        assert r.intent == Intent.CONFIRMATION


# ── Email capture ─────────────────────────────────────────────────────────────

class TestEmailCapture:
    def test_standalone_email(self):
        r = detect("darren@example.com")
        assert r.intent == Intent.EMAIL_CAPTURE
        assert r.entities.get("email") == "darren@example.com"

    def test_email_extracted(self):
        r = detect("My email is jessica@books.com")
        assert r.entities.get("email") == "jessica@books.com"


# ── Price question ────────────────────────────────────────────────────────────

class TestPriceQuestion:
    def test_how_much(self):
        r = detect("How much does it cost?")
        assert r.intent == Intent.PRICE_QUESTION

    def test_price_keyword(self):
        r = detect("What's the price of Dune?")
        assert r.intent == Intent.PRICE_QUESTION


# ── Shipping question ─────────────────────────────────────────────────────────

class TestShippingQuestion:
    def test_shipping(self):
        r = detect("How long does shipping take?")
        assert r.intent == Intent.SHIPPING_QUESTION

    def test_delivery(self):
        r = detect("How long does standard shipping take?")
        assert r.intent == Intent.SHIPPING_QUESTION


# ── Unknown ───────────────────────────────────────────────────────────────────

class TestUnknown:
    def test_gibberish(self):
        r = detect("xkcd foo bar")
        assert r.intent == Intent.UNKNOWN
        assert r.confidence == 0.0

    def test_empty_string(self):
        r = detect("")
        assert r.intent == Intent.UNKNOWN


# ── Entity extraction ─────────────────────────────────────────────────────────

class TestEntityExtraction:
    def test_order_number_with_hash(self):
        r = detect("status of order #1234")
        assert r.entities.get("order_number") == "#1234"

    def test_order_number_no_hash(self):
        r = detect("my order number is 5678")
        assert r.entities.get("order_number") == "#5678"

    def test_email_in_order_lookup(self):
        r = detect("order 1234 my email is test@example.com")
        assert r.entities.get("email") == "test@example.com"
        assert r.entities.get("order_number") == "#1234"

    def test_no_entities_in_greeting(self):
        r = detect("Hi there")
        assert r.entities == {} or r.entities.get("isbn") is None


# ── IntentResult dataclass ────────────────────────────────────────────────────

class TestIntentResult:
    def test_dataclass_defaults(self):
        r = IntentResult(intent="unknown", confidence=0.0)
        assert r.entities == {}
        assert r.suggested_tools == []
        assert r.needs_filler is False

    def test_session_param_optional(self):
        r = detect("hello", session=None)
        assert r.intent == Intent.GREETING
