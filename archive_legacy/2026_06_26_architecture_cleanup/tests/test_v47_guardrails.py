"""v4.7 — candidate guard, cart memory, cart confirmation, ISBN validator."""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.cart.candidate import save_product_candidate
from app.cart.candidate_guard import should_save_candidate
from app.cart.session import get_ledger, sync_ledger_to_session
from app.dialogue.manager import DialogueManager
from app.tools.isbn_validator import process_isbn_buffer, should_search_isbn
from app.payment.scope_audit import audit_payment_scope
from app.state.models import SessionState
from app.workers.cart_mutation_worker import CartMutationWorker


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="s-g", call_sid="CA_G01",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


class TestCandidateGuard:
    def test_memory_question_blocks(self):
        ok, _ = should_save_candidate("first_book_question", "What is first book title?")
        assert not ok

    def test_title_only_blocks(self):
        ok, _ = should_save_candidate("product_search", "Title?")
        assert not ok

    def test_explicit_title_allows(self):
        ok, _ = should_save_candidate("book_title_search", "I need the book called Just Mercy")
        assert ok

    def test_isbn_always_allowed(self):
        ok, _ = should_save_candidate("isbn_search", "9781962022064", is_isbn=True)
        assert ok

    def test_memory_save_blocked(self):
        s = _session()
        item = save_product_candidate(
            s, title="Random", variant_id="gid://1",
            source_intent="first_book_question", source_query="first book title",
        )
        assert item is None


class TestCartMemory:
    def test_first_book_from_cart(self):
        s = _session()
        ledger = get_ledger(s)
        from app.cart.ledger import CartItem
        ledger._items.append(CartItem(
            title="Raising Telepathic Children",
            isbn="9781962022064", variant_id="gid://1",
            confirmation_status="confirmed", eligible_for_checkout=True,
        ))
        ledger._items.append(CartItem(
            title="Keep Talking",
            isbn="9798998627002", variant_id="gid://2",
            confirmation_status="confirmed", eligible_for_checkout=True,
        ))
        sync_ledger_to_session(s, ledger)
        text = DialogueManager.build_memory_response(s, "first_book_question")
        assert "Raising Telepathic Children" in text

    def test_selected_books(self):
        s = _session()
        ledger = get_ledger(s)
        from app.cart.ledger import CartItem
        for title, isbn in (("Raising Telepathic Children", "9781"), ("Keep Talking", "9798")):
            ledger._items.append(CartItem(
                title=title, isbn=isbn, variant_id=f"gid://{isbn}",
                confirmation_status="confirmed", eligible_for_checkout=True,
            ))
        sync_ledger_to_session(s, ledger)
        text = DialogueManager.build_memory_response(s, "selected_books_question")
        assert "2 books" in text.lower()
        assert "Raising Telepathic Children" in text
        assert "Keep Talking" in text


class TestCartConfirmScope:
    @pytest.mark.asyncio
    async def test_both_confirms_only_two_eligible(self):
        s = _session()
        ledger = get_ledger(s)
        from app.cart.ledger import CartItem
        for isbn, title in (("978111", "Real 1"), ("978222", "Real 2")):
            ledger._items.append(CartItem(
                title=title, isbn=isbn, variant_id=f"gid://{isbn}",
                confirmation_status="candidate", candidate_guard_allowed=True,
            ))
        for title in ("Blocked 1", "Blocked 2", "Blocked 3"):
            ledger._items.append(CartItem(
                title=title, variant_id=f"gid://x{title}",
                confirmation_status="candidate", candidate_guard_allowed=False,
            ))
        sync_ledger_to_session(s, ledger)
        worker = CartMutationWorker()
        from app.config import Settings
        result = await worker.run(
            s,
            {"intent": "add_to_cart", "raw_text": "both books", "confirm_all": "true"},
            Settings(OPENAI_API_KEY="test"),
        )
        ledger = get_ledger(s)
        assert ledger.confirmed_count() == 2


class TestISBNValidator:
    def test_fragment_merge_97989938618(self):
        r = process_isbn_buffer("0 7", "97989938618")
        assert "9798993861807" in (r.buffer or r.isbn or "")

    def test_complete_isbn_9798998627002(self):
        r = process_isbn_buffer("2", "979899862700")
        assert r.action == "complete"
        assert r.isbn == "9798998627002"

    def test_short_979_prefix_no_search(self):
        assert not should_search_isbn("9798993861")

    def test_last_part_appends(self):
        r = process_isbn_buffer("61807", "979899386")
        assert "61807" in r.buffer or r.action == "ask_remaining"


class TestPaymentScopeAudit:
    def test_requested_two_cart_five_blocks(self):
        s = _session()
        s.cart_items = [
            {"title": f"B{i}", "variant_id": f"gid://{i}", "confirmation_status": "confirmed",
             "eligible_for_checkout": True, "isbn": f"978{i}"}
            for i in range(5)
        ]
        items, audit = audit_payment_scope(
            s, {"requested_cart_count": "2"}, "send both books payment link",
        )
        assert audit.blocked
        assert audit.checkout_count == 5
        assert not items

    def test_two_eligible_three_blocked_checkout_two(self):
        s = _session()
        s.cart_items = [
            {"title": "A", "variant_id": "gid://1", "confirmation_status": "confirmed",
             "eligible_for_checkout": True},
            {"title": "B", "variant_id": "gid://2", "confirmation_status": "confirmed",
             "eligible_for_checkout": True},
            {"title": "X", "variant_id": "gid://3", "confirmation_status": "confirmed",
             "eligible_for_checkout": False, "candidate_guard_allowed": False},
            {"title": "Y", "variant_id": "gid://4", "confirmation_status": "confirmed",
             "eligible_for_checkout": False},
            {"title": "Z", "variant_id": "gid://5", "confirmation_status": "confirmed",
             "eligible_for_checkout": False},
        ]
        items, audit = audit_payment_scope(s, {}, "")
        assert len(items) == 2
        assert audit.checkout_count == 2
