"""Tests for cart inquiry short-circuit."""
from __future__ import annotations

from app.agent_runtime.commerce_flow_state import try_cart_inquiry_reply
from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
from app.state.models import SessionState


def _session_with_cart() -> SessionState:
    session = SessionState(
        call_sid="CAcart01",
        session_id="sess-cart",
        from_number="+15551234567",
        to_number="+15559876543",
    )
    add_product_candidate(
        session,
        title="Secrets to Hearing God's Voice",
        isbn="9798881507428",
        variant_id="v1",
        price="12.99",
        quantity=1,
    )
    confirm_last_candidate(session)
    add_product_candidate(
        session,
        title="The Autobiography of Miss Jane Pittman",
        isbn="9780553263572",
        variant_id="v2",
        price="9.99",
        quantity=2,
    )
    confirm_last_candidate(session)
    add_product_candidate(
        session,
        title="The Satanic Bible",
        isbn="9780380015399",
        variant_id="v3",
        price="14.99",
        quantity=3,
    )
    confirm_last_candidate(session)
    assert get_ledger(session).confirmed_count() == 3
    return session


def test_cart_count_inquiry():
    session = _session_with_cart()
    reply = try_cart_inquiry_reply(session, "How many books are in my cart?")
    assert reply is not None
    assert "3 titles" in reply
    assert "6 copies" in reply


def test_third_book_inquiry():
    session = _session_with_cart()
    reply = try_cart_inquiry_reply(
        session,
        "What is the third book in my cart? Give me the title and copies.",
    )
    assert reply is not None
    assert "third book" in reply.lower()
    assert "Satanic Bible" in reply
