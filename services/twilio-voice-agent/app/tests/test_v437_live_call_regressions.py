"""v4.37 — live call CA9ee8 regressions: yes confirm, title vs ISBN."""
from __future__ import annotations

from app.agent_runtime.commerce_flow_state import (
    STATUS_AWAITING_ADD_CONFIRM,
    STATUS_AWAITING_ANOTHER_BOOK,
    _confirms_pending_add,
    process_commerce_turn,
    stage_product_candidate,
)
from app.agent_runtime.isbn_short_circuit import (
    looks_like_book_title_request,
    should_skip_isbn_short_circuit,
)
from app.state.models import SessionState

BOOK_A = {
    "title": "A Clash of Kings: A Song of Ice and Fire: Book Two",
    "variant_id": "gid://shopify/ProductVariant/1",
    "price": "10.99",
    "available": True,
}


def _session() -> SessionState:
    return SessionState(
        session_id="s1",
        call_sid="CA9ee801",
        from_number="+1",
        to_number="+2",
    )


class TestYesConfirmAdd:
    def test_bare_yes_confirms_add(self):
        assert _confirms_pending_add("Yes.") is True

    def test_yes_with_coffee_stt_confirms(self):
        assert _confirms_pending_add("Yes. Add 1 coffee.") is True

    def test_frustration_with_yes_confirms(self):
        assert _confirms_pending_add("When I say yes Why are you not continue?") is True

    def test_add_confirm_adds_on_bare_yes(self):
        session = _session()
        stage_product_candidate(session, BOOK_A)
        session.commerce_flow_status = STATUS_AWAITING_ADD_CONFIRM
        session.commerce_pending_quantity = 1
        hint = process_commerce_turn(session, "Yes.")
        assert hint.book_added is True
        assert "another product" in (hint.force_reply or "").lower()

    def test_add_confirm_adds_on_yes_add_copy(self):
        session = _session()
        stage_product_candidate(session, BOOK_A)
        session.commerce_flow_status = STATUS_AWAITING_ADD_CONFIRM
        session.commerce_pending_quantity = 1
        hint = process_commerce_turn(session, "Yes. Add 1 coffee.")
        assert hint.book_added is True


class TestTitleNotIsbn:
    def test_newspaper_title_not_isbn(self):
        t = "Achilles' Citizen Time, Monday Sunday, 7 day delivery for 4 weeks."
        assert looks_like_book_title_request(t) is True

    def test_skip_isbn_when_awaiting_another_book(self):
        session = _session()
        session.commerce_flow_status = STATUS_AWAITING_ANOTHER_BOOK
        session.pending_isbn_buffer = "97805535799"
        t = "Achilles' Citizen Time, Monday Sunday, 7 day delivery for 4 weeks."
        assert should_skip_isbn_short_circuit(session, t) is True
        assert session.pending_isbn_buffer == ""

    def test_its_a_title_without_name_is_not_catalog_query(self):
        assert looks_like_book_title_request("It's a title.") is False
