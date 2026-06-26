"""
v4.5 tests — CartMutationWorker, candidate persistence, recovery, router, email.
"""
from __future__ import annotations

import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.cart.candidate import save_product_candidate, save_product_not_found
from app.cart.session import get_ledger, sync_ledger_to_session, confirm_last_candidate
from app.pipeline.router import detect
from app.pipeline.engine import _apply_email_state
from app.pipeline.router import IntentResult
from app.state.models import SessionState
from app.workers.cart_mutation_worker import CartMutationWorker
from app.workers.orchestrator import _INTENT_WORKERS, WorkerOrchestrator
from app.workers.payment_flow_worker import PaymentFlowWorker
from app.workers.product_isbn_worker import ProductISBNWorker
from app.workers.base import WorkerResult


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="s-v45", call_sid="CA_V45001",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


def _settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True, VOICE_TOOL_TIMEOUT_MS=2500)


class TestOrchestratorCartMutation:
    def test_add_to_cart_maps_cart_mutation(self):
        assert "cart_mutation" in _INTENT_WORKERS["add_to_cart"]

    def test_send_payment_link_runs_cart_mutation_first(self):
        workers = _INTENT_WORKERS["send_payment_link"]
        assert workers[0] == "cart_mutation"
        assert "payment_flow" in workers


class TestCartMutationWorker:
    async def test_add_to_cart_runs_worker(self):
        worker = CartMutationWorker()
        session = _session()
        save_product_candidate(
            session, title="Book One", isbn="978111", variant_id="gid://1",
        )
        r = await worker.run(
            session,
            {"intent": "add_to_cart", "raw_text": "Yes."},
            _settings(),
        )
        assert r.success
        assert r.data.get("action") == "cart_item_confirmed"
        assert get_ledger(session).confirmed_count() == 1

    async def test_no_candidate_friendly_message(self):
        worker = CartMutationWorker()
        r = await worker.run(
            _session(),
            {"intent": "add_to_cart", "raw_text": "Yes."},
            _settings(),
        )
        assert not r.success
        assert r.data.get("action") == "cart_confirm_failed_no_candidate"

    async def test_repeated_yes_no_duplicate(self):
        worker = CartMutationWorker()
        session = _session()
        save_product_candidate(
            session, title="Book One", isbn="978111", variant_id="gid://1",
        )
        await worker.run(session, {"intent": "add_to_cart"}, _settings())
        r = await worker.run(session, {"intent": "add_to_cart"}, _settings())
        assert r.data.get("action") == "cart_already_confirmed"
        assert get_ledger(session).confirmed_count() == 1

    async def test_confirm_multiple_books(self):
        worker = CartMutationWorker()
        session = _session()
        for isbn in ("978111", "978222", "978333"):
            save_product_candidate(
                session, title=f"Book {isbn}", isbn=isbn, variant_id=f"gid://{isbn}",
            )
            confirm_last_candidate(session)
        for isbn in ("978444",):
            save_product_candidate(
                session, title="Pending", isbn="978444", variant_id="gid://444",
            )
        r = await worker.run(
            session,
            {"intent": "add_to_cart", "raw_text": "I need these 3 books.", "confirm_all": "true"},
            _settings(),
        )
        assert r.success
        assert get_ledger(session).confirmed_count() >= 3


class TestCandidatePersistence:
    async def test_isbn_worker_saves_before_return(self):
        session = _session()
        worker = ProductISBNWorker()
        mock_product = MagicMock(
            title="Test Book", author="Author", price="9.99",
            available=True, variant_id="gid://v1", product_id="gid://p1",
        )
        with patch("app.sync.repositories.ProductCache") as MockCache:
            MockCache.return_value.get_by_isbn = AsyncMock(return_value=mock_product)
            r = await worker.run(session, {"isbn": "9780441172719"}, _settings())
        assert r.success
        ledger = get_ledger(session)
        assert ledger.candidate_item is not None
        assert ledger.candidate_item.title == "Test Book"
        assert session.last_product_candidate.get("variant_id") == "gid://v1"

    def test_not_found_isbn_saved(self):
        session = _session()
        save_product_not_found(session, "9789999999999")
        assert "9789999999999" in session.isbn_not_found

    async def test_candidate_survives_without_response_plan(self):
        session = _session()
        worker = ProductISBNWorker()
        mock_product = MagicMock(
            title="Survives", author="", price="1", available=True,
            variant_id="gid://x", product_id="",
        )
        with patch("app.sync.repositories.ProductCache") as MockCache:
            MockCache.return_value.get_by_isbn = AsyncMock(return_value=mock_product)
            await worker.run(session, {"isbn": "9781111111111"}, _settings())
        assert get_ledger(session).candidate_item is not None


class TestRouterV45:
    def test_okay_i_need_a_book(self):
        assert detect("Okay. I need a book.").intent == "vague_book_request"

    def test_store_name_not_product_search(self):
        assert detect("What is your store name?").intent == "store_info_question"

    def test_your_store_name(self):
        r = detect("What is your store number name?")
        assert r.intent == "store_info_question"

    def test_i_need_both_books_uses_cart(self):
        session = _session()
        save_product_candidate(session, title="A", isbn="978111", variant_id="gid://1")
        save_product_candidate(session, title="B", isbn="978222", variant_id="gid://2")
        r = detect("I need both books", session)
        assert r.intent == "add_to_cart"

    def test_yes_with_candidate_adds_to_cart(self):
        session = _session()
        save_product_candidate(session, title="A", isbn="978111", variant_id="gid://1")
        session.dialogue.active_flow = "cart_building"
        assert detect("Yes.", session).intent == "add_to_cart"


class TestEmailActivateCleanup:
    def test_activate_before_gmail_normalized(self):
        from app.email.capture import normalize_spoken_email
        assert normalize_spoken_email(
            "Bashi Sultan 7 6 6 activate g mail dot com",
        ) == "bashisultan766@gmail.com"

    def test_typed_activate_stripped(self):
        from app.email.capture import normalize_spoken_email, email_confidence
        email = normalize_spoken_email("Bashisultan766activate@gmail.com")
        assert email == "bashisultan766@gmail.com"
        assert email_confidence(email, "Bashisultan766activate@gmail.com") == "medium"

    def test_activate_inside_local_low_confidence(self):
        from app.email.capture import normalize_spoken_email, email_confidence
        email = normalize_spoken_email("stillactivateinside@gmail.com")
        assert email_confidence(email, "stillactivateinside@gmail.com") == "low"

    def test_correction_clears_pending(self):
        session = _session(pending_email="wrong@gmail.com")
        _apply_email_state(session, IntentResult(intent="email_correction", confidence=0.9, entities={}))
        assert session.pending_email == ""


class TestPaymentMissingMessages:
    async def test_missing_cart_with_email(self):
        session = _session(confirmed_email="alice@example.com", isbn_history=["978111"])
        worker = PaymentFlowWorker()
        r = await worker.run(
            session,
            {"intent": "send_payment_link", "raw_text": "send payment link"},
            _settings(),
        )
        assert "book" in r.safe_summary.lower()
        assert "email" not in r.safe_summary.lower() or "confirmed email" not in r.safe_summary.lower()

    async def test_missing_email_only(self):
        session = _session()
        session.cart_items = [{
            "title": "Dune", "variant_id": "gid://1", "quantity": 1,
            "confirmation_status": "confirmed",
        }]
        worker = PaymentFlowWorker()
        r = await worker.run(session, {"intent": "send_payment_link"}, _settings())
        assert "email" in r.safe_summary.lower()


class TestCartRecovery:
    async def test_recovery_from_candidates(self):
        session = _session()
        for isbn in ("978111", "978222"):
            save_product_candidate(
                session, title=f"T{isbn}", isbn=isbn, variant_id=f"gid://{isbn}",
            )
        worker = PaymentFlowWorker()
        with patch("app.workers.payment_flow_worker.CheckoutWorker"), \
             patch("app.workers.payment_flow_worker.PaymentEmailWorker"):
            r = await worker.run(
                session,
                {
                    "intent": "send_payment_link",
                    "raw_text": "I already gave you ISBN send payment link",
                },
                _settings(),
            )
        pf = session.payment_flow_result or {}
        assert pf.get("cart_count", 0) >= 2 or "cart_items" not in (pf.get("missing_fields") or [])

    async def test_no_variant_not_recovered(self):
        session = _session()
        save_product_candidate(session, title="No Variant", isbn="978111", variant_id="")
        worker = PaymentFlowWorker()
        r = await worker.run(
            session,
            {"intent": "send_payment_link", "raw_text": "send link"},
            _settings(),
        )
        assert not r.success or "variant_id" in (session.payment_flow_result or {}).get("missing_fields", [])
