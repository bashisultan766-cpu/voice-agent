"""v4.6 tests — router phrase improvements."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.pipeline.router import detect
from app.cart.candidate import save_product_candidate
from app.cart.session import get_ledger, confirm_last_candidate
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="s-r", call_sid="CA_R01",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


class TestRouterV46:
    def test_already_gave_isbn_memory(self):
        r = detect("I already gave you the ISBN", session=_session())
        assert r.intent == "memory_summary_question"

    def test_sent_three_isbns_count(self):
        r = detect("I sent you three ISBN numbers", session=_session())
        assert r.intent == "isbn_count_question"

    def test_send_both_books_payment(self):
        s = _session()
        for isbn in ("978111", "978222"):
            save_product_candidate(s, title=f"B{isbn}", isbn=isbn, variant_id=f"gid://{isbn}")
            confirm_last_candidate(s)
        r = detect("send both books", session=s)
        assert r.intent == "send_payment_link"

    def test_send_those_books_payment(self):
        s = _session()
        save_product_candidate(s, title="Book", isbn="978111", variant_id="gid://1")
        confirm_last_candidate(s)
        r = detect("send those books", session=s)
        assert r.intent == "send_payment_link"

    def test_what_did_i_give_memory(self):
        r = detect("what did I give you", session=_session())
        assert r.intent == "memory_summary_question"

    def test_what_do_you_have_so_far(self):
        r = detect("what do you have so far", session=_session())
        assert r.intent == "memory_summary_question"

    def test_store_name_intent(self):
        r = detect("what's your store name", session=_session())
        assert r.intent == "store_info_question"

    def test_need_both_books_cart_context(self):
        s = _session()
        for isbn in ("978111", "978222"):
            save_product_candidate(s, title=f"B{isbn}", isbn=isbn, variant_id=f"gid://{isbn}")
            confirm_last_candidate(s)
        r = detect("I need both books", session=s)
        assert r.intent == "add_to_cart"
