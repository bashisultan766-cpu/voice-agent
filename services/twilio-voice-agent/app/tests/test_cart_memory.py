"""Session-scoped CartMemory — call lifetime only, no DB persistence."""
from __future__ import annotations

import pytest

from app.cart.ledger import CartItem
from app.cart.session import sync_ledger_to_session, get_ledger
from app.runtime.cart_memory import (
    CartMemory,
    CartMemoryItem,
    cart_memory_runtime_scope,
    clear_cart_memory_on_session_end,
    get_cart_memory,
    sync_cart_memory_from_ledger,
)
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="cart-mem",
        call_sid="CAcart123",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


def test_add_to_cart_merges_by_isbn():
    memory = CartMemory()
    memory.add_to_cart(
        CartMemoryItem(product_title="Book A", isbn="978-1", quantity=1)
    )
    memory.add_to_cart(
        CartMemoryItem(product_title="Book A", isbn="978-1", quantity=2)
    )
    assert len(memory.items) == 1
    assert memory.items[0].quantity == 3


def test_update_quantity_by_identifier():
    memory = CartMemory()
    memory.add_to_cart(
        {"product_title": "Deep Work", "identifier": "v-deep", "quantity": 1}
    )
    assert memory.update_quantity({"identifier": "v-deep"}, quantity=4)
    assert memory.items[0].quantity == 4
    assert memory.update_quantity({"identifier": "missing"}, quantity=2) is False


def test_clear_cart_on_session_end():
    memory = CartMemory()
    memory.add_to_cart(CartMemoryItem(product_title="X", isbn="1"))
    memory.clear_cart_on_session_end()
    assert memory.items == []


def test_get_cart_memory_requires_runtime_context():
    session = _session()
    with pytest.raises(RuntimeError, match="voice_commerce_runtime"):
        get_cart_memory(session)


def test_get_cart_memory_inside_runtime_scope():
    session = _session()
    with cart_memory_runtime_scope():
        memory = get_cart_memory(session)
        memory.add_to_cart(CartMemoryItem(product_title="Scoped", isbn="99"))
        assert session.cart_memory is memory
        assert memory.to_dict_list()[0]["product_title"] == "Scoped"


def test_clear_cart_memory_on_session_end():
    session = _session()
    with cart_memory_runtime_scope():
        get_cart_memory(session).add_to_cart(
            CartMemoryItem(product_title="Gone", isbn="0")
        )
    clear_cart_memory_on_session_end(session)
    assert session.cart_memory is None


def test_sync_cart_memory_from_ledger():
    session = _session()
    ledger = get_ledger(session)
    ledger.add_candidate(
        CartItem(
            title="Atomic Habits",
            isbn="978-1",
            variant_id="v1",
            quantity=2,
            confirmation_status="confirmed",
        )
    )
    ledger.add_candidate(
        CartItem(
            title="Deep Work",
            isbn="978-2",
            variant_id="v2",
            quantity=1,
            confirmation_status="confirmed",
        )
    )
    sync_ledger_to_session(session, ledger)

    with cart_memory_runtime_scope():
        memory = sync_cart_memory_from_ledger(session)
        lines = memory.to_dict_list()

    assert len(lines) == 2
    assert lines[0]["product_title"] == "Atomic Habits"
    assert lines[0]["isbn"] == "978-1"
    assert lines[0]["quantity"] == 2
    assert lines[1]["product_title"] == "Deep Work"
