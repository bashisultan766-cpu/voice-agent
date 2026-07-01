"""Deterministic product cart short-circuit — no LLM for add-to-cart."""
from __future__ import annotations

from app.agent_runtime.commerce_flow_state import (
    STATUS_AWAITING_ANOTHER_BOOK,
    STATUS_AWAITING_QUANTITY,
    stage_product_candidate,
    try_product_cart_short_circuit,
)
from app.runtime.cart_memory import cart_memory_runtime_scope
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="pcs-cart",
        call_sid="CApcscart1",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


def _stage(session: SessionState) -> None:
    stage_product_candidate(session, {
        "title": "Atomic Habits",
        "isbn": "9780747532699",
        "variant_id": "v1",
        "price": "$12",
        "available": True,
    })


def test_quantity_prompt_when_awaiting_quantity():
    session = _session()
    _stage(session)
    hint = try_product_cart_short_circuit(session, "hello?")
    assert hint is not None
    assert hint.openai_skipped
    assert "how many copies" in hint.force_reply.lower()
    assert session.commerce_flow_status == STATUS_AWAITING_QUANTITY


def test_add_to_cart_on_quantity_response():
    session = _session()
    _stage(session)
    hint = try_product_cart_short_circuit(session, "two copies")
    assert hint is not None
    assert hint.book_added
    assert hint.openai_skipped
    assert "added" in hint.force_reply.lower()
    assert "another product" in hint.force_reply.lower()
    assert session.commerce_flow_status == STATUS_AWAITING_ANOTHER_BOOK


def test_bare_yes_after_quantity_prompt_adds_one():
    session = _session(
        commerce_flow_status=STATUS_AWAITING_QUANTITY,
        commerce_last_voice_reply="Found it — Atomic Habits. How many copies would you like?",
    )
    stage_product_candidate(session, {
        "title": "Atomic Habits",
        "isbn": "9780747532699",
        "variant_id": "v1",
        "price": "$12",
        "available": True,
    })
    hint = try_product_cart_short_circuit(session, "Yes.")
    assert hint is not None
    assert hint.book_added
    assert "one copy" in hint.force_reply.lower()


def test_cart_memory_synced_after_add():
    session = _session()
    _stage(session)
    hint = try_product_cart_short_circuit(session, "1 copy")
    assert hint is not None
    assert hint.book_added
