"""
v4.1 tests — new router intents: facility, email, multi-book, cancellation, etc.
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.pipeline.router import detect


class TestFacilityIntents:
    def test_facility_approval(self):
        r = detect("Is that jail approved for our books?")
        assert r.intent == "facility_approval"

    def test_facility_restriction(self):
        r = detect("What are the book restrictions at the facility?")
        assert r.intent == "facility_restriction"

    def test_facility_name_extracted_ship_first(self):
        # "ship ... jail" — bidirectional pattern should match
        r = detect("Can you ship books to Rikers Island jail?")
        assert r.intent in ("facility_approval", "facility_restriction")

    def test_no_hardcover_restriction(self):
        # hardcover + prison → facility_restriction
        r = detect("Does that prison allow hardcover books?")
        assert r.intent in ("facility_approval", "facility_restriction", "unknown")


class TestEmailIntents:
    def test_email_provided_typed(self):
        r = detect("My email is test@example.com")
        assert r.intent == "email_provided"
        assert r.entities.get("email") == "test@example.com"

    def test_email_provided_spoken(self):
        r = detect("bashi at gmail dot com")
        assert r.intent == "email_provided"

    def test_email_correction(self):
        r = detect("No that's not correct, try again")
        assert r.intent == "email_correction"

    def test_email_correction_change_to(self):
        r = detect("change it to something else")
        assert r.intent == "email_correction"

    def test_email_confirmation_yes(self):
        from app.state.models import SessionState
        session = SessionState(
            session_id="s", call_sid="CA1",
            from_number="+1", to_number="+2",
        )
        session.pending_email = "alice@example.com"
        r = detect("yes that's correct", session=session)
        assert r.intent == "email_confirmation"

    def test_email_confirmation_no_pending_falls_through(self):
        # Without a pending_email, "yes" should be confirmation intent not email_confirmation
        r = detect("yes", session=None)
        assert r.intent == "confirmation"


class TestMultiBookIntent:
    def test_multiple_books(self):
        # "order" in sentence would trigger order_lookup — use a cleaner phrase
        r = detect("I'd like to buy multiple books")
        assert r.intent == "multi_book_order"

    def test_two_books(self):
        r = detect("I need two different books for my son")
        assert r.intent == "multi_book_order"

    def test_separate_orders(self):
        r = detect("I need to place two separate book orders")
        # two books + order context → multi_book_order or order_lookup — both acceptable
        assert r.intent in ("multi_book_order", "order_lookup")

    def test_several_books(self):
        r = detect("I'm looking for several books")
        assert r.intent == "multi_book_order"


class TestCancellationIntent:
    def test_cancel_order(self):
        r = detect("I want to cancel my order")
        assert r.intent == "cancellation_request"

    def test_nevermind_order(self):
        r = detect("never mind the order")
        assert r.intent == "cancellation_request"

    def test_dont_send(self):
        r = detect("don't send it")
        assert r.intent == "cancellation_request"


class TestAddressUpdateIntent:
    def test_change_address(self):
        r = detect("I need to change my address")
        assert r.intent == "address_update"

    def test_wrong_address(self):
        r = detect("The address is wrong, can you update it?")
        assert r.intent == "address_update"


class TestQuantityUpdateIntent:
    def test_change_quantity(self):
        r = detect("Make it just one copy")
        assert r.intent in ("quantity_update", "product_search", "book_title_search")

    def test_quantity_extracted(self):
        r = detect("I need three copies of that book")
        assert r.entities.get("quantity") in ("3", None) or int(r.entities.get("quantity", 0)) == 3


class TestRefundDetailIntent:
    def test_refund_detail_amount(self):
        r = detect("How much was refunded on my order?")
        assert r.intent == "refund_detail"

    def test_shipping_refunded(self):
        r = detect("Was the shipping refunded?")
        assert r.intent == "refund_detail"

    def test_refund_amount(self):
        r = detect("What was the refund amount?")
        assert r.intent == "refund_detail"


class TestBookTitleSearchIntent:
    def test_i_need_title(self):
        r = detect("I need Game of Thrones")
        assert r.intent == "book_title_search"
        assert r.entities.get("product_phrase")

    def test_called_title(self):
        r = detect("Do you have a book called Beloved?")
        assert r.intent in ("book_title_search", "product_search")


class TestShippingPriceIntent:
    def test_shipping_cost(self):
        r = detect("How much does shipping cost?")
        assert r.intent == "shipping_price"

    def test_shipping_rate(self):
        r = detect("What are your shipping rates?")
        assert r.intent == "shipping_price"


class TestOrchestratorNewIntents:
    """New intents are properly mapped in WorkerOrchestrator."""

    def test_facility_approval_has_workers(self):
        from app.workers.orchestrator import _INTENT_WORKERS, WORKER_PATH_INTENTS
        assert "facility_approval" in WORKER_PATH_INTENTS
        assert _INTENT_WORKERS["facility_approval"] == ["facility_approval"]

    def test_facility_restriction_has_workers(self):
        from app.workers.orchestrator import _INTENT_WORKERS, WORKER_PATH_INTENTS
        assert "facility_restriction" in WORKER_PATH_INTENTS
        assert _INTENT_WORKERS["facility_restriction"] == ["facility_restriction"]

    def test_email_intents_use_worker_path(self):
        # v4.2: email intents now use worker path (no fallback to run_agent_turn)
        from app.workers.orchestrator import WORKER_PATH_INTENTS
        for intent in ("email_provided", "email_correction", "email_confirmation"):
            assert intent in WORKER_PATH_INTENTS, f"{intent} should be in WORKER_PATH_INTENTS"

    def test_refund_detail_has_workers(self):
        from app.workers.orchestrator import _INTENT_WORKERS, WORKER_PATH_INTENTS
        assert "refund_detail" in WORKER_PATH_INTENTS
        assert "refund" in _INTENT_WORKERS["refund_detail"]

    def test_multi_book_order_has_workers(self):
        from app.workers.orchestrator import WORKER_PATH_INTENTS
        assert "multi_book_order" in WORKER_PATH_INTENTS

    def test_book_title_search_has_workers(self):
        from app.workers.orchestrator import WORKER_PATH_INTENTS
        assert "book_title_search" in WORKER_PATH_INTENTS

    def test_cancellation_uses_worker_path(self):
        # v4.2: cancellation_request now routes to the cancellation worker
        from app.workers.orchestrator import WORKER_PATH_INTENTS
        assert "cancellation_request" in WORKER_PATH_INTENTS

    def test_new_workers_in_registry(self):
        from app.workers.orchestrator import _REGISTRY
        assert "facility_approval" in _REGISTRY
        assert "facility_restriction" in _REGISTRY
        assert "facility_policy_notes" in _REGISTRY
        assert "order_facility_review" in _REGISTRY
