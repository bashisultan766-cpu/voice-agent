"""Drop shipping fee for checkout drafts and payment emails (v4.36)."""
from __future__ import annotations

from typing import Any

from ..config import get_settings

CUSTOMER_LABEL = "Drop Shipping Fee"


def book_line_subtotal(lines: list[dict[str, Any]]) -> float:
    total = 0.0
    for line in lines or []:
        if line.get("is_fee"):
            continue
        try:
            unit = float(str(line.get("price") or "0").replace("$", "").strip())
            total += unit * int(line.get("quantity") or 1)
        except (TypeError, ValueError):
            continue
    return round(total, 2)


def compute_drop_shipping_fee(lines: list[dict[str, Any]]) -> float:
    settings = get_settings()
    if not getattr(settings, "DROP_SHIPPING_FEE_ENABLED", True):
        return 0.0
    subtotal = book_line_subtotal(lines)
    if subtotal <= 0:
        return 0.0
    rate = float(getattr(settings, "DROP_SHIPPING_FEE_RATE", 0.03) or 0.03)
    fee = round(subtotal * rate, 2)
    minimum = float(getattr(settings, "DROP_SHIPPING_FEE_MIN", 0.0) or 0.0)
    if fee < minimum:
        fee = minimum
    return fee


def fee_line_for_email(amount: float) -> dict[str, Any]:
    return {
        "title": CUSTOMER_LABEL,
        "quantity": 1,
        "price": f"{amount:.2f}",
        "is_fee": True,
    }


def draft_line_item_for_fee(amount: float) -> dict[str, Any]:
    return {
        "title": CUSTOMER_LABEL,
        "quantity": 1,
        "originalUnitPrice": f"{amount:.2f}",
    }


def append_fee_to_draft_line_items(
    line_items: list[dict[str, Any]],
    book_lines: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    fee = compute_drop_shipping_fee(book_lines)
    if fee <= 0:
        return line_items
    return [*line_items, draft_line_item_for_fee(fee)]


def checkout_email_lines(book_lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Book rows plus drop shipping fee row for branded payment email."""
    rows = [
        {
            "title": line.get("title") or "Book",
            "quantity": int(line.get("quantity") or 1),
            "price": line.get("price") or "",
        }
        for line in book_lines or []
        if not line.get("is_fee")
    ]
    fee = compute_drop_shipping_fee(rows)
    if fee > 0:
        rows.append(fee_line_for_email(fee))
    return rows


def order_subtotal_with_fee(lines: list[dict[str, Any]]) -> float:
    books = book_line_subtotal(lines)
    fee = compute_drop_shipping_fee(lines)
    return round(books + fee, 2)
