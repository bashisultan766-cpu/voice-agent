"""
CartLedger — session-scoped multi-book cart for the voice agent.

Tracks books the caller has requested, confirmed, and wants to purchase.
Never loses earlier books when the caller says "another book."
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class CartItem:
    title: str
    isbn: str = ""
    variant_id: str = ""
    product_id: str = ""
    quantity: int = 1
    price: Optional[str] = None
    currency: str = "USD"
    available: bool = True
    source: str = "search"           # search | isbn | manual
    confirmation_status: str = "candidate"  # candidate | confirmed | rejected


class CartLedger:
    """Manages the multi-book cart for one call."""

    def __init__(self) -> None:
        self._items: list[CartItem] = []
        self._last_candidate_idx: Optional[int] = None
        self._isbn_provided: list[str] = []
        self._isbn_not_found: list[str] = []

    @property
    def items(self) -> list[CartItem]:
        return list(self._items)

    @property
    def confirmed_items(self) -> list[CartItem]:
        return [i for i in self._items if i.confirmation_status == "confirmed"]

    @property
    def candidate_item(self) -> Optional[CartItem]:
        if self._last_candidate_idx is not None:
            idx = self._last_candidate_idx
            if 0 <= idx < len(self._items):
                item = self._items[idx]
                if item.confirmation_status == "candidate":
                    return item
        candidates = [i for i in self._items if i.confirmation_status == "candidate"]
        return candidates[-1] if candidates else None

    def add_candidate(self, item: CartItem) -> None:
        """Add a new book candidate (e.g. after ISBN/title search result)."""
        if item.isbn:
            for existing in self._items:
                if existing.isbn == item.isbn and existing.confirmation_status != "rejected":
                    existing.title = item.title or existing.title
                    existing.variant_id = item.variant_id or existing.variant_id
                    existing.price = item.price or existing.price
                    self._last_candidate_idx = self._items.index(existing)
                    return
        self._items.append(item)
        self._last_candidate_idx = len(self._items) - 1

    def confirm_last_candidate(self) -> Optional[CartItem]:
        """Caller said yes — confirm the last candidate."""
        candidate = self.candidate_item
        if candidate:
            candidate.confirmation_status = "confirmed"
        return candidate

    def reject_last_candidate(self) -> Optional[CartItem]:
        """Caller said no to last candidate."""
        candidate = self.candidate_item
        if candidate:
            candidate.confirmation_status = "rejected"
        return candidate

    def update_quantity(self, isbn_or_title: str, quantity: int) -> bool:
        for item in self._items:
            if item.isbn == isbn_or_title or item.title.lower() == isbn_or_title.lower():
                item.quantity = max(1, quantity)
                return True
        return False

    def count(self) -> int:
        return len([i for i in self._items if i.confirmation_status != "rejected"])

    def confirmed_count(self) -> int:
        return len(self.confirmed_items)

    def titles(self, confirmed_only: bool = False) -> list[str]:
        items = self.confirmed_items if confirmed_only else [
            i for i in self._items if i.confirmation_status != "rejected"
        ]
        return [i.title for i in items if i.title]

    def to_checkout_items(self) -> list[dict]:
        return [
            {
                "variant_id": i.variant_id,
                "quantity": i.quantity,
                "title": i.title,
                "price": i.price,
            }
            for i in self.confirmed_items
            if i.variant_id
        ]

    def to_session_format(self) -> list[dict]:
        return [
            {
                "variant_id": i.variant_id,
                "quantity": i.quantity,
                "title": i.title,
                "price": i.price or "N/A",
                "isbn": i.isbn,
                "product_id": i.product_id,
                "source": i.source,
                "confirmation_status": i.confirmation_status,
                "available": i.available,
            }
            for i in self._items
            if i.confirmation_status != "rejected"
        ]

    def record_isbn_provided(self, isbn: str) -> None:
        if isbn and isbn not in self._isbn_provided:
            self._isbn_provided.append(isbn)

    def record_isbn_not_found(self, isbn: str) -> None:
        self.record_isbn_provided(isbn)
        if isbn and isbn not in self._isbn_not_found:
            self._isbn_not_found.append(isbn)

    @property
    def isbn_provided(self) -> list[str]:
        return list(self._isbn_provided)

    @property
    def isbn_not_found(self) -> list[str]:
        return list(self._isbn_not_found)

    def isbn_provided_count(self) -> int:
        return len(self._isbn_provided)

    def found_titles_ordered(self) -> list[str]:
        """Titles for found products (candidate or confirmed), in order."""
        return [
            i.title for i in self._items
            if i.title and i.confirmation_status != "rejected"
        ]

    def titles_one_by_one_summary(self) -> str:
        """Voice-friendly list of found titles and not-found ISBNs."""
        parts: list[str] = []
        found = self.found_titles_ordered()
        for idx, title in enumerate(found, start=1):
            parts.append(f"The {'first' if idx == 1 else f'{idx}'} book is {title}.")
        for isbn in self._isbn_not_found:
            parts.append(f"ISBN {isbn} did not return a matching title.")
        return " ".join(parts) if parts else ""

    def cart_summary_text(self) -> str:
        confirmed = self.confirmed_items
        if not confirmed:
            return "No books confirmed in your cart yet."
        titles = ", ".join(i.title for i in confirmed if i.title)
        return f"{len(confirmed)} book{'s' if len(confirmed) != 1 else ''} in cart: {titles}."

    @classmethod
    def from_session(cls, cart_items: list, isbn_history: list | None = None,
                     isbn_not_found: list | None = None) -> "CartLedger":
        ledger = cls()
        for raw in cart_items or []:
            if not isinstance(raw, dict):
                continue
            ledger._items.append(CartItem(
                title=raw.get("title", ""),
                isbn=raw.get("isbn", ""),
                variant_id=raw.get("variant_id", ""),
                product_id=raw.get("product_id", ""),
                quantity=int(raw.get("quantity") or 1),
                price=raw.get("price"),
                available=raw.get("available", True),
                source=raw.get("source", "search"),
                confirmation_status=raw.get("confirmation_status", "candidate"),
            ))
        if ledger._items:
            for i, item in enumerate(ledger._items):
                if item.confirmation_status == "candidate":
                    ledger._last_candidate_idx = i
                    break
        for isbn in isbn_history or []:
            ledger.record_isbn_provided(isbn)
        for isbn in isbn_not_found or []:
            ledger.record_isbn_not_found(isbn)
        return ledger
