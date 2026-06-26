"""
Commerce cart service — session-scoped multi-item cart for voice sales.

Wraps CartLedger with a clean API for the Main Commerce Brain and runtime.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional

from ..cart.ledger import CartItem, CartLedger
from ..cart.session import get_ledger, sync_ledger_to_session

if TYPE_CHECKING:
    from ..state.models import SessionState


@dataclass
class CartSummary:
    item_count: int
    confirmed_count: int
    subtotal: float
    summary_text: str
    items: list[dict]


class CommerceCartService:
    """Voice commerce cart operations backed by CartLedger."""

    def __init__(self, session: "SessionState") -> None:
        self._session = session
        self._ledger = get_ledger(session)

    def _persist(self) -> None:
        sync_ledger_to_session(self._session, self._ledger)

    @property
    def ledger(self) -> CartLedger:
        return self._ledger

    def add_item(
        self,
        *,
        title: str,
        product_id: str = "",
        variant_id: str = "",
        isbn: str = "",
        price: str | None = None,
        quantity: int = 1,
        available: bool = True,
        confirm: bool = False,
    ) -> CartItem:
        item = CartItem(
            title=title,
            product_id=product_id,
            variant_id=variant_id,
            isbn=isbn,
            price=price,
            quantity=max(1, int(quantity or 1)),
            available=available,
            source="isbn" if isbn else "search",
            confirmation_status="confirmed" if confirm else "candidate",
            eligible_for_checkout=confirm,
        )
        if confirm:
            self._ledger.add_candidate(item)
            self._ledger.confirm_last_candidate()
        else:
            self._ledger.add_candidate(item)
        self._persist()
        return item

    def confirm_last(self) -> Optional[CartItem]:
        item = self._ledger.confirm_last_candidate()
        self._persist()
        return item

    def reject_last(self) -> Optional[CartItem]:
        item = self._ledger.reject_last_candidate()
        self._persist()
        return item

    def update_quantity(self, isbn_or_title: str, quantity: int) -> bool:
        ok = self._ledger.update_quantity(isbn_or_title, quantity)
        if ok:
            self._persist()
        return ok

    def remove_item(self, isbn_or_title: str) -> bool:
        key = (isbn_or_title or "").strip().lower()
        if not key:
            return False
        before = len(self._ledger.items)
        self._ledger._items = [
            i for i in self._ledger._items
            if i.isbn.lower() != key and i.title.lower() != key
        ]
        ok = len(self._ledger._items) < before
        if ok:
            self._persist()
        return ok

    def get_summary(self) -> CartSummary:
        confirmed = self._ledger.confirmed_items
        subtotal = 0.0
        for item in confirmed:
            try:
                price = float(str(item.price or "0").replace("$", "").strip())
            except ValueError:
                price = 0.0
            subtotal += price * item.quantity

        items = [
            {
                "title": i.title,
                "product_id": i.product_id,
                "variant_id": i.variant_id,
                "isbn": i.isbn,
                "quantity": i.quantity,
                "price": i.price,
                "available": i.available,
                "selected_for_checkout": i.eligible_for_checkout,
            }
            for i in confirmed
        ]

        return CartSummary(
            item_count=self._ledger.count(),
            confirmed_count=len(confirmed),
            subtotal=subtotal,
            summary_text=self._ledger.cart_summary_text(),
            items=items,
        )

    def checkout_summary_prompt(self) -> str:
        """Spoken cart summary before payment link."""
        summary = self.get_summary()
        if not summary.items:
            return "Your cart is empty. What book would you like to add?"
        titles = []
        for item in summary.items:
            qty = item["quantity"]
            title = item["title"]
            if qty > 1:
                titles.append(f"{qty} copies of {title}")
            else:
                titles.append(title)
        joined = " and ".join(titles[:4])
        if len(titles) > 4:
            joined += f" and {len(titles) - 4} more"
        subtotal_str = f"${summary.subtotal:.2f}" if summary.subtotal else "the listed price"
        return (
            f"You have {len(summary.items)} item{'s' if len(summary.items) != 1 else ''}: "
            f"{joined}. The subtotal is {subtotal_str}. "
            "Should I send the payment link to your email?"
        )

    def has_confirmed_items(self) -> bool:
        return self._ledger.confirmed_count() > 0

    def mark_cart_confirmed(self) -> None:
        self._session.payment_cart_confirmed = True
        self._session.awaiting_cart_confirmation = False
