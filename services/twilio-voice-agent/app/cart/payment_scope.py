"""Payment cart scope selection (v4.4)."""
from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..state.models import SessionState

_SCOPE_COUNT = re.compile(
    r"\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+books?\b",
    re.IGNORECASE,
)
_FIRST_TWO = re.compile(r"\b(first two|first 2|top two)\b", re.IGNORECASE)
_LAST_TWO = re.compile(r"\b(last two|last 2|bottom two)\b", re.IGNORECASE)
_ALL_BOOKS = re.compile(r"\b(all|every|the \d+ books?|4 books?|four books?)\b", re.IGNORECASE)

_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}


def _confirmed_checkout_items(session: "SessionState") -> list[dict[str, Any]]:
    items: list[dict] = []
    for raw in getattr(session, "cart_items", []) or []:
        if not isinstance(raw, dict):
            continue
        if raw.get("confirmation_status") not in ("confirmed", "candidate"):
            if raw.get("confirmation_status") == "rejected":
                continue
        if not raw.get("variant_id"):
            continue
        items.append(raw)
    # Prefer confirmed only for payment
    confirmed = [i for i in items if i.get("confirmation_status") == "confirmed"]
    return confirmed if confirmed else items


def parse_scope_from_text(text: str, entities: dict) -> dict[str, Any]:
    """Extract payment scope hints from utterance."""
    scope: dict[str, Any] = {}
    t = text.lower()
    m = _SCOPE_COUNT.search(t)
    if m:
        val = m.group(1).lower()
        scope["payment_scope_count"] = int(val) if val.isdigit() else _WORDS.get(val, 0)
    if entities.get("requested_cart_count"):
        scope["payment_scope_count"] = int(entities["requested_cart_count"])
    if _FIRST_TWO.search(t):
        scope["payment_scope_mode"] = "first_n"
        scope["payment_scope_count"] = scope.get("payment_scope_count", 2)
    elif _LAST_TWO.search(t):
        scope["payment_scope_mode"] = "last_n"
        scope["payment_scope_count"] = scope.get("payment_scope_count", 2)
    elif _ALL_BOOKS.search(t) or "all" in t and "book" in t:
        scope["payment_scope_mode"] = "all"
    return scope


def resolve_payment_scope(
    session: "SessionState",
    entities: dict,
    raw_text: str = "",
) -> tuple[list[dict[str, Any]], str | None]:
    """
    Return (items for checkout, clarification_message or None).

    clarification_message is set when scope is ambiguous (e.g. 4 in cart, ask for 2).
    """
    items = _confirmed_checkout_items(session)
    if not items:
        return [], None

    scope = parse_scope_from_text(raw_text, entities)
    count = scope.get("payment_scope_count") or getattr(session, "payment_scope_count", 0)
    mode = scope.get("payment_scope_mode") or getattr(session, "payment_scope_mode", "")

    if mode == "all" or (count and count >= len(items)):
        session.payment_scope_items = [i.get("isbn") or i.get("title") for i in items]
        return items, None

    if mode == "first_n" and count:
        selected = items[:count]
        session.payment_scope_items = [i.get("isbn") or i.get("title") for i in selected]
        return selected, None

    if mode == "last_n" and count:
        selected = items[-count:]
        session.payment_scope_items = [i.get("isbn") or i.get("title") for i in selected]
        return selected, None

    if count and count < len(items):
        return [], (
            f"Which {count} books should I include — the first {count}, "
            f"the last {count}, or specific titles?"
        )

    session.payment_scope_items = [i.get("isbn") or i.get("title") for i in items]
    return items, None
