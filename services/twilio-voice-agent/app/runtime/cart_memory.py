"""
Session-scoped cart memory for voice_commerce_runtime (call lifetime only).

Mirrors call_memory lifecycle: lives on SessionState, never persisted to DB,
cleared explicitly when the call ends.
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

CART_MEMORY_VERSION = "v1.0"

_runtime_context_active: ContextVar[bool] = ContextVar(
    "voice_commerce_cart_memory_context",
    default=False,
)


@dataclass
class CartMemoryItem:
    """One line in the session cart."""

    product_title: str
    quantity: int = 1
    isbn: str = ""
    identifier: str = ""

    def __post_init__(self) -> None:
        self.product_title = (self.product_title or "").strip()
        self.isbn = (self.isbn or "").strip()
        self.identifier = (self.identifier or "").strip()
        self.quantity = max(1, int(self.quantity or 1))

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> "CartMemoryItem":
        isbn = str(data.get("isbn") or "").strip()
        variant_id = str(data.get("variant_id") or "").strip()
        product_id = str(data.get("product_id") or "").strip()
        identifier = (
            str(data.get("identifier") or "").strip()
            or isbn
            or variant_id
            or product_id
        )
        return cls(
            product_title=str(data.get("product_title") or data.get("title") or ""),
            quantity=int(data.get("quantity") or 1),
            isbn=isbn,
            identifier=identifier,
        )

    def match_key(self) -> str:
        for key in (self.isbn, self.identifier, self.product_title):
            if key:
                return key.lower()
        return ""


@dataclass
class CartMemory:
    """In-call cart — multiple products, no persistence."""

    items: list[CartMemoryItem] = field(default_factory=list)

    def add_to_cart(self, item: CartMemoryItem | dict[str, Any]) -> CartMemoryItem:
        """Add or merge a cart line by ISBN / identifier / title."""
        entry = item if isinstance(item, CartMemoryItem) else CartMemoryItem.from_mapping(item)
        if not entry.product_title and not entry.match_key():
            return entry

        key = entry.match_key()
        if key:
            for existing in self.items:
                if existing.match_key() == key:
                    existing.quantity = max(1, existing.quantity + entry.quantity)
                    if entry.product_title:
                        existing.product_title = entry.product_title
                    if entry.isbn:
                        existing.isbn = entry.isbn
                    if entry.identifier:
                        existing.identifier = entry.identifier
                    return existing

        self.items.append(entry)
        return entry

    def update_quantity(
        self,
        item: CartMemoryItem | dict[str, Any],
        *,
        quantity: int | None = None,
    ) -> bool:
        """Set quantity for a line matched by ISBN / identifier / title."""
        probe = item if isinstance(item, CartMemoryItem) else CartMemoryItem.from_mapping(item)
        qty = max(1, int(quantity if quantity is not None else probe.quantity))
        key = probe.match_key()
        if not key:
            return False
        for existing in self.items:
            if existing.match_key() == key:
                existing.quantity = qty
                return True
        return False

    def clear_cart_on_session_end(self) -> None:
        """Drop all lines when the call session closes."""
        self.items.clear()

    def to_dict_list(self) -> list[dict[str, Any]]:
        return [
            {
                "product_title": i.product_title,
                "isbn": i.isbn,
                "identifier": i.identifier,
                "quantity": i.quantity,
            }
            for i in self.items
        ]


def _require_runtime_context() -> None:
    if not _runtime_context_active.get():
        raise RuntimeError(
            "CartMemory is only accessible inside voice_commerce_runtime session context"
        )


@contextmanager
def cart_memory_runtime_scope():
    """Mark the current task as inside voice_commerce_runtime (CartMemory gate)."""
    token: Token = _runtime_context_active.set(True)
    try:
        yield
    finally:
        _runtime_context_active.reset(token)


def get_cart_memory(session: "SessionState") -> CartMemory:
    """Return session cart memory (runtime context required)."""
    _require_runtime_context()
    raw = getattr(session, "cart_memory", None)
    if isinstance(raw, CartMemory):
        return raw
    memory = CartMemory()
    session.cart_memory = memory
    return memory


def clear_cart_memory_on_session_end(session: "SessionState") -> None:
    """Clear cart memory when the call disconnects (no DB persistence)."""
    raw = getattr(session, "cart_memory", None)
    if isinstance(raw, CartMemory):
        raw.clear_cart_on_session_end()
    session.cart_memory = None
    logger.debug(
        "cart_memory_cleared sid=%s",
        (getattr(session, "call_sid", "") or "")[:6],
    )


def sync_cart_memory_from_ledger(session: "SessionState") -> CartMemory:
    """
    Rebuild CartMemory from confirmed CartLedger lines (runtime-only).

    Keeps session cart memory aligned with commerce cart operations.
    """
    _require_runtime_context()
    from ..cart.session import get_ledger

    memory = get_cart_memory(session)
    memory.clear_cart_on_session_end()

    for line in get_ledger(session).confirmed_items:
        memory.add_to_cart(
            CartMemoryItem(
                product_title=line.title or "",
                isbn=line.isbn or "",
                identifier=line.variant_id or line.product_id or line.isbn or "",
                quantity=max(1, int(line.quantity or 1)),
            )
        )
    return memory
