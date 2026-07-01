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
    selection_origin: str = ""       # isbn_confirmed | title_confirmed | author_confirmed | manual_selected
    eligible_for_checkout: bool = False
    source_intent: str = ""
    source_query: str = ""
    candidate_guard_allowed: bool = True


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
        if item.variant_id:
            for idx, existing in enumerate(self._items):
                if (
                    existing.variant_id == item.variant_id
                    and existing.confirmation_status == "candidate"
                ):
                    existing.title = item.title or existing.title
                    existing.isbn = item.isbn or existing.isbn
                    existing.price = item.price or existing.price
                    if item.quantity > 0:
                        existing.quantity = item.quantity
                    self._last_candidate_idx = idx
                    return
        if item.isbn:
            for idx, existing in enumerate(self._items):
                if existing.isbn != item.isbn or existing.confirmation_status == "rejected":
                    continue
                if (
                    existing.confirmation_status == "confirmed"
                    and item.variant_id
                    and existing.variant_id
                    and existing.variant_id != item.variant_id
                ):
                    continue
                existing.title = item.title or existing.title
                existing.variant_id = item.variant_id or existing.variant_id
                existing.price = item.price or existing.price
                if item.quantity > 0:
                    if existing.confirmation_status == "confirmed":
                        existing.quantity = max(existing.quantity, item.quantity)
                    else:
                        existing.quantity = max(existing.quantity, item.quantity)
                self._last_candidate_idx = idx
                return
        self._items.append(item)
        self._last_candidate_idx = len(self._items) - 1

    def confirm_last_candidate(self) -> Optional[CartItem]:
        """Caller said yes — confirm the last eligible candidate."""
        candidate = self.eligible_candidate_item
        if candidate:
            candidate.confirmation_status = "confirmed"
            candidate.eligible_for_checkout = True
            if not candidate.selection_origin:
                candidate.selection_origin = (
                    "isbn_confirmed" if candidate.isbn else "title_confirmed"
                )
        return candidate

    @property
    def eligible_candidate_item(self) -> Optional[CartItem]:
        """Most recent pending candidate allowed by candidate guard."""
        candidates = [
            i for i in self._items
            if i.confirmation_status == "candidate"
            and i.candidate_guard_allowed
        ]
        return candidates[-1] if candidates else None

    def eligible_pending_candidates(self) -> list[CartItem]:
        return [
            i for i in self._items
            if i.confirmation_status == "candidate"
            and i.candidate_guard_allowed
        ]

    def reject_last_candidate(self) -> Optional[CartItem]:
        """Caller said no to last candidate."""
        candidate = self.candidate_item
        if candidate:
            candidate.confirmation_status = "rejected"
        return candidate

    def update_quantity(self, isbn_or_title: str, quantity: int, *, variant_id: str = "") -> bool:
        if variant_id:
            for item in self._items:
                if (
                    item.variant_id == variant_id
                    and item.confirmation_status != "rejected"
                ):
                    item.quantity = max(1, quantity)
                    return True
        needle = (isbn_or_title or "").strip().lower()
        for item in self._items:
            if item.confirmation_status == "rejected":
                continue
            if item.isbn == isbn_or_title:
                item.quantity = max(1, quantity)
                return True
            if needle and item.title.lower() == needle:
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

    def confirmed_titles(self) -> list[str]:
        return [i.title for i in self.confirmed_items if i.title]

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
                "selection_origin": i.selection_origin,
                "eligible_for_checkout": i.eligible_for_checkout,
                "source_intent": i.source_intent,
                "source_query": i.source_query,
                "candidate_guard_allowed": i.candidate_guard_allowed,
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
        """Voice-friendly list of confirmed cart titles with copy counts."""
        parts: list[str] = []
        confirmed = self.confirmed_items
        ordinals = ("first", "second", "third", "fourth", "fifth")
        for idx, item in enumerate(confirmed, start=1):
            qty = max(1, int(item.quantity or 1))
            copy_phrase = "one copy" if qty == 1 else f"{qty} copies"
            ord_label = ordinals[idx - 1] if idx <= len(ordinals) else str(idx)
            parts.append(
                f"The {ord_label} book is {item.title} — {copy_phrase}."
            )
        for isbn in self._isbn_not_found:
            parts.append(f"ISBN {isbn} did not return a matching title.")
        return " ".join(parts) if parts else ""

    def cart_summary_text(self) -> str:
        confirmed = self.confirmed_items
        if not confirmed:
            return "No books confirmed in your cart yet."
        total_copies = sum(max(1, int(i.quantity or 1)) for i in confirmed)
        lines: list[str] = []
        subtotal = 0.0
        for i in confirmed:
            qty = max(1, int(i.quantity or 1))
            copy_word = "copy" if qty == 1 else "copies"
            price_str = ""
            if i.price:
                try:
                    unit = float(str(i.price).replace("$", "").strip())
                    line_total = unit * qty
                    subtotal += line_total
                    price_str = f" at ${unit:.2f} each"
                except ValueError:
                    price_str = f" at {i.price} each"
            lines.append(f"{qty} {copy_word} of {i.title}{price_str}")
        detail = "; ".join(lines)
        summary = (
            f"{len(confirmed)} title{'s' if len(confirmed) != 1 else ''}, "
            f"{total_copies} total cop{'y' if total_copies == 1 else 'ies'}: {detail}."
        )
        if subtotal > 0:
            from ..payment.drop_shipping_fee import compute_drop_shipping_fee, CUSTOMER_LABEL

            fee = compute_drop_shipping_fee(
                [{"title": i.title, "quantity": i.quantity, "price": i.price} for i in confirmed]
            )
            total_with_fee = subtotal + fee
            summary += (
                f" Subtotal before shipping is ${total_with_fee:.2f}"
                f" (includes {CUSTOMER_LABEL.lower()})."
                " Postal shipping is calculated on the payment page."
            )
        return summary

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
                selection_origin=raw.get("selection_origin", ""),
                eligible_for_checkout=bool(
                    raw.get(
                        "eligible_for_checkout",
                        raw.get("confirmation_status") == "confirmed",
                    )
                ),
                source_intent=raw.get("source_intent", ""),
                source_query=raw.get("source_query", ""),
                candidate_guard_allowed=raw.get("candidate_guard_allowed", True),
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
