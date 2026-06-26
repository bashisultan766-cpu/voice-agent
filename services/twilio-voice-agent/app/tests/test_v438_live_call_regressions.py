"""v4.38 — live call CA0a91 regressions: another-book, hold, email vs ISBN."""
from __future__ import annotations

import pytest

from app.agent_runtime.commerce_flow_state import (
    COMMERCE_FLOW_VERSION,
    STATUS_AWAITING_ADD_CONFIRM,
    STATUS_AWAITING_ANOTHER_BOOK,
    STATUS_AWAITING_QUANTITY,
    process_commerce_turn,
    stage_product_candidate,
)
from app.agent_runtime.isbn_short_circuit import (
    ISBN_SHORT_CIRCUIT_VERSION,
    looks_like_book_title_request,
    payment_email_context_active,
    should_skip_isbn_short_circuit,
)
from app.payment.payment_state_machine import process_payment_turn
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="s1",
        call_sid="CA0a9165f097e146117725a78ec83b429d",
        from_number="+1",
        to_number="+2",
        commerce_flow_status="idle",
        payment_flow_status="idle",
        cart_items=[],
    )
    base.update(kwargs)
    return SessionState(**base)


def test_version_bump():
    assert COMMERCE_FLOW_VERSION == "v4.44"
    assert ISBN_SHORT_CIRCUIT_VERSION == "v4.43"


def test_another_one_is_not_title_catalog_query():
    assert looks_like_book_title_request("Yeah. I need another 1.") is False


@pytest.mark.asyncio
async def test_skip_isbn_during_awaiting_another_book_meta_phrase():
    session = _session(commerce_flow_status=STATUS_AWAITING_ANOTHER_BOOK)
    assert should_skip_isbn_short_circuit(session, "Yeah. I need another 1.") is True


def test_hold_during_awaiting_quantity_does_not_repeat_found_it():
    session = _session()
    stage_product_candidate(
        session,
        {
            "title": "The Accidental Copywriter",
            "variant_id": "gid://shopify/ProductVariant/1",
            "price": "17.00",
        },
    )
    assert session.commerce_flow_status == STATUS_AWAITING_QUANTITY
    hint = process_commerce_turn(session, "Just hold a second.")
    reply = hint.force_reply or ""
    assert not reply.startswith("Found it")
    assert "how many copies" in reply.lower()


def test_yes_bro_confirms_pending_add():
    session = _session()
    stage_product_candidate(
        session,
        {
            "title": "A Thug's Heartbeat",
            "variant_id": "gid://shopify/ProductVariant/2",
            "price": "8.99",
        },
    )
    session.commerce_flow_status = STATUS_AWAITING_ADD_CONFIRM
    session.commerce_pending_quantity = 2
    hint = process_commerce_turn(session, "Yes, bro. Yes. Speak speak something.")
    assert hint.book_added is True


def test_payment_email_context_blocks_isbn_buffer():
    session = _session(
        payment_flow_status="awaiting_email_confirmation",
        awaiting_payment_email_confirmation=True,
    )
    session.pending_isbn_buffer = "766766766766"
    assert payment_email_context_active(session) is True
    assert should_skip_isbn_short_circuit(session, "It's not correct.") is True
    assert session.pending_isbn_buffer == ""


def test_email_correction_reprompts_not_isbn_digits():
    session = _session(
        payment_flow_status="awaiting_email_confirmation",
        awaiting_payment_email_confirmation=True,
        pending_payment_email="wrong@example.com",
        cart_items=[
            {
                "title": "Test Book",
                "variant_id": "gid://shopify/ProductVariant/9",
                "quantity": 1,
            }
        ],
    )
    session.pending_isbn_buffer = "766766766766"
    hint = process_payment_turn(session, "It's not correct.")
    assert hint.force_reply
    assert "email" in hint.force_reply.lower()
    assert "digit" not in hint.force_reply.lower()
    assert session.pending_isbn_buffer == ""


def test_spoken_email_fragment_during_awaiting_email():
    session = _session(
        payment_flow_status="awaiting_email",
        awaiting_payment_email=True,
        cart_items=[
            {
                "title": "Test Book",
                "variant_id": "gid://shopify/ProductVariant/9",
                "quantity": 1,
            }
        ],
    )
    hint = process_payment_turn(session, "Bashi Sultan 766 activate g mail dot com.")
    assert hint.force_reply
    assert "email" in hint.force_reply.lower() or "continue" in hint.force_reply.lower()
