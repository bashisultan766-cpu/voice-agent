"""
Unit tests for the rule-based intent classifier and entity extractor.
No external dependencies — pure CPU work.
"""
import pytest
from app.voice.intent import Intent, classify_intent


# ── Instant triggers (bypass LLM) ────────────────────────────────────────────

class TestInstantTriggers:
    def test_hi_is_instant_greeting(self):
        r = classify_intent("hi")
        assert r.intent == Intent.GREETING
        assert r.is_instant is True
        assert r.confidence == 1.0

    def test_hello_is_instant_greeting(self):
        r = classify_intent("hello")
        assert r.intent == Intent.GREETING
        assert r.is_instant is True

    def test_bye_is_instant_farewell(self):
        r = classify_intent("bye")
        assert r.intent == Intent.FAREWELL
        assert r.is_instant is True

    def test_goodbye_is_instant_farewell(self):
        r = classify_intent("goodbye")
        assert r.intent == Intent.FAREWELL
        assert r.is_instant is True

    def test_no_thanks_is_instant_farewell(self):
        r = classify_intent("no thanks")
        assert r.intent == Intent.FAREWELL
        assert r.is_instant is True

    def test_good_morning_is_instant_greeting(self):
        r = classify_intent("good morning")
        assert r.intent == Intent.GREETING
        assert r.is_instant is True


# ── Product search intent ─────────────────────────────────────────────────────

class TestProductSearch:
    def test_looking_for_book(self):
        r = classify_intent("I'm looking for a book on Python programming")
        assert r.intent == Intent.PRODUCT_SEARCH
        assert r.confidence >= 0.75

    def test_do_you_have(self):
        r = classify_intent("Do you have Harry Potter?")
        assert r.intent == Intent.PRODUCT_SEARCH

    def test_price_query(self):
        r = classify_intent("How much does that book cost?")
        assert r.intent == Intent.PRODUCT_SEARCH

    def test_isbn_boosts_confidence(self):
        r = classify_intent("I need ISBN 9780743273565")
        assert r.intent == Intent.PRODUCT_SEARCH
        assert r.confidence >= 0.95
        assert r.entities.isbn == "9780743273565"

    def test_author_search(self):
        r = classify_intent("Do you carry books by Stephen King?")
        assert r.intent == Intent.PRODUCT_SEARCH


# ── Order lookup intent ───────────────────────────────────────────────────────

class TestOrderLookup:
    def test_track_order(self):
        r = classify_intent("I want to track my order")
        assert r.intent == Intent.ORDER_LOOKUP
        assert r.confidence >= 0.80

    def test_order_with_number(self):
        r = classify_intent("What is the status of order #1234?")
        assert r.intent == Intent.ORDER_LOOKUP
        assert r.confidence >= 0.90
        assert r.entities.order_number == "1234"

    def test_order_number_alternative_phrasing(self):
        r = classify_intent("Can you check order number 5678?")
        assert r.intent == Intent.ORDER_LOOKUP
        assert r.entities.order_number == "5678"

    def test_where_is_my_order(self):
        r = classify_intent("Where's my package?")
        assert r.intent == Intent.ORDER_LOOKUP

    def test_email_in_order_query_boosts_confidence(self):
        r = classify_intent("Check order status for bob@example.com")
        assert r.intent == Intent.ORDER_LOOKUP
        assert r.confidence >= 0.90
        assert r.entities.email == "bob@example.com"


# ── Checkout intent ───────────────────────────────────────────────────────────

class TestCheckout:
    def test_buy_product(self):
        r = classify_intent("I'd like to buy this book")
        assert r.intent == Intent.CHECKOUT

    def test_checkout(self):
        r = classify_intent("I want to checkout now")
        assert r.intent == Intent.CHECKOUT

    def test_place_order(self):
        r = classify_intent("Please place an order for me")
        assert r.intent == Intent.CHECKOUT


# ── Recommendation intent ─────────────────────────────────────────────────────

class TestRecommendation:
    def test_recommend_books(self):
        r = classify_intent("Can you recommend some books?")
        assert r.intent == Intent.RECOMMENDATION

    def test_best_sellers(self):
        r = classify_intent("What are your best sellers?")
        assert r.intent == Intent.RECOMMENDATION

    def test_suggest(self):
        r = classify_intent("What would you suggest for a mystery lover?")
        assert r.intent == Intent.RECOMMENDATION


# ── Email capture ─────────────────────────────────────────────────────────────

class TestEmailCapture:
    def test_email_address(self):
        r = classify_intent("My email is alice@example.com")
        assert r.intent == Intent.EMAIL_CAPTURE
        assert r.entities.email == "alice@example.com"

    def test_send_to_email(self):
        r = classify_intent("Send it to john.doe@gmail.com")
        assert r.entities.email == "john.doe@gmail.com"


# ── Entity extraction ─────────────────────────────────────────────────────────

class TestEntityExtraction:
    def test_extracts_isbn_10(self):
        r = classify_intent("I need 0743273567")
        assert r.entities.isbn == "0743273567"

    def test_extracts_isbn_13(self):
        r = classify_intent("The ISBN is 978-0-7432-7356-5")
        # ISBN_RE groups raw digits
        assert r.entities.isbn is not None

    def test_extracts_email(self):
        r = classify_intent("track order for user@domain.co.uk")
        assert r.entities.email == "user@domain.co.uk"

    def test_product_query_cleaned(self):
        r = classify_intent("I am looking for Harry Potter")
        assert r.entities.product_query is not None
        assert "looking for" not in r.entities.product_query.lower()

    def test_no_entities_for_instant(self):
        r = classify_intent("hi")
        assert r.entities.isbn is None
        assert r.entities.email is None
        assert r.entities.order_number is None


# ── Other / ambiguous ─────────────────────────────────────────────────────────

class TestOther:
    def test_gibberish_is_other(self):
        r = classify_intent("xyzzy foo bar qux")
        assert r.intent == Intent.OTHER
        assert r.confidence == 0.50

    def test_empty_string_is_other(self):
        r = classify_intent("")
        assert r.intent == Intent.OTHER

    def test_short_yes_is_other(self):
        r = classify_intent("yes")
        # "yes" has no pattern match; classified as OTHER
        assert r.intent == Intent.OTHER
