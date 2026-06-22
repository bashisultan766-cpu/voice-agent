"""Session ↔ CartLedger sync helpers."""
from __future__ import annotations

from typing import TYPE_CHECKING

from .ledger import CartItem, CartLedger

if TYPE_CHECKING:
    from ..state.models import SessionState


def get_ledger(session: "SessionState") -> CartLedger:
    return CartLedger.from_session(
        getattr(session, "cart_items", []) or [],
        isbn_history=getattr(session, "isbn_history", None),
        isbn_not_found=getattr(session, "isbn_not_found", None),
    )


def sync_ledger_to_session(session: "SessionState", ledger: CartLedger) -> None:
    session.cart_items = ledger.to_session_format()
    session.isbn_history = ledger.isbn_provided
    session.isbn_not_found = ledger.isbn_not_found


def add_product_candidate(
    session: "SessionState",
    *,
    title: str,
    isbn: str = "",
    variant_id: str = "",
    price: str | None = None,
    available: bool = True,
) -> CartItem:
    ledger = get_ledger(session)
    item = CartItem(
        title=title,
        isbn=isbn,
        variant_id=variant_id,
        price=price,
        available=available,
        source="isbn" if isbn else "search",
    )
    ledger.add_candidate(item)
    sync_ledger_to_session(session, ledger)
    session.last_product_title = title
    session.last_product_variant_id = variant_id
    return item
