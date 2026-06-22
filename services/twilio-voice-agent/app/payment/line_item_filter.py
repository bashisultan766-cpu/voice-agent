"""
Line item filter — blocks internal/fee items from Shopify checkout (v4.8).

Processing Fee and any internal fee products must never appear as customer-facing
line items. This module is the single gate that enforces that rule.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

_FEE_TITLE_PATTERNS = re.compile(
    r"\b(processing\s*fee|service\s*fee|internal\s*fee|handling\s*fee|"
    r"admin\s*fee|convenience\s*fee)\b",
    re.IGNORECASE,
)

_FEE_EXACT = frozenset({
    "processing fee",
    "service fee",
    "internal fee",
    "handling fee",
    "admin fee",
    "convenience fee",
})


@dataclass
class FilterResult:
    included: list[dict] = field(default_factory=list)
    excluded: list[dict] = field(default_factory=list)
    excluded_fee_count: int = 0
    excluded_reasons: list[str] = field(default_factory=list)


def detect_internal_fee_item(item: dict[str, Any]) -> bool:
    """Return True if this line item is an internal fee that must not be customer-facing."""
    title = str(item.get("title") or item.get("name") or "").strip()
    if not title:
        return False
    lower = title.lower()
    if lower in _FEE_EXACT:
        return True
    if _FEE_TITLE_PATTERNS.search(title):
        return True
    return False


def is_customer_facing_book_item(item: dict[str, Any]) -> bool:
    """Return True only for genuine book line items that may go to checkout."""
    if detect_internal_fee_item(item):
        return False
    variant_id = item.get("variant_id") or item.get("variantId") or ""
    if not variant_id:
        return False
    return True


def filter_checkout_line_items(items: list[dict[str, Any]]) -> FilterResult:
    """
    Filter a list of cart/checkout items, excluding internal fee items.

    Logs one line per excluded item for audit trail.
    """
    result = FilterResult()
    for item in items:
        if detect_internal_fee_item(item):
            title = str(item.get("title") or item.get("name") or "")
            safe_title = re.sub(r"[a-zA-Z]", "X", title)  # mask for log
            logger.warning(
                "checkout_line_filter excluded=1 reason=internal_fee title_safe=%s",
                safe_title,
            )
            result.excluded.append(item)
            result.excluded_fee_count += 1
            result.excluded_reasons.append("internal_fee")
        else:
            result.included.append(item)
    return result
