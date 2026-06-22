"""
Availability states and response templates (v4.8).

Centralises the four states: in_stock, out_of_stock, backorder, unknown.
Each state has an exact voice response. No guessing.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

AVAILABILITY_IN_STOCK = "in_stock"
AVAILABILITY_OUT_OF_STOCK = "out_of_stock"
AVAILABILITY_BACKORDER = "backorder"
AVAILABILITY_UNKNOWN = "unknown"

_RESPONSES = {
    AVAILABILITY_IN_STOCK: "That title is currently in stock.",
    AVAILABILITY_OUT_OF_STOCK: "That title is currently not in stock.",
    AVAILABILITY_BACKORDER: (
        "That book is currently on backorder. "
        "That means it is not available to ship immediately, "
        "but it may be fulfilled once stock is available."
    ),
    AVAILABILITY_UNKNOWN: (
        "I don't want to guess on availability. "
        "I can forward this to customer service."
    ),
}


@dataclass
class AvailabilityResult:
    status: str  # one of the four constants above
    title: str = ""
    eligible_for_checkout: bool = False
    safe_response: str = ""

    def __post_init__(self) -> None:
        if not self.safe_response:
            self.safe_response = _RESPONSES.get(self.status, _RESPONSES[AVAILABILITY_UNKNOWN])
        if self.status == AVAILABILITY_IN_STOCK:
            self.eligible_for_checkout = True


def availability_from_shopify(
    title: str,
    available: bool,
    inventory_quantity: Optional[int] = None,
) -> AvailabilityResult:
    """Determine availability from Shopify data, applying stock overrides."""
    from .stock_overrides import apply_stock_override

    avail, status = apply_stock_override(title, available)

    if status == AVAILABILITY_OUT_OF_STOCK:
        return AvailabilityResult(status=AVAILABILITY_OUT_OF_STOCK, title=title)

    if status == AVAILABILITY_IN_STOCK:
        return AvailabilityResult(status=AVAILABILITY_IN_STOCK, title=title)

    if inventory_quantity is not None and inventory_quantity <= 0 and not available:
        return AvailabilityResult(status=AVAILABILITY_OUT_OF_STOCK, title=title)

    if available:
        return AvailabilityResult(status=AVAILABILITY_IN_STOCK, title=title)

    return AvailabilityResult(status=AVAILABILITY_OUT_OF_STOCK, title=title)


def availability_response(status: str) -> str:
    return _RESPONSES.get(status, _RESPONSES[AVAILABILITY_UNKNOWN])
