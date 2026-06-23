"""Catalog product orderability assessment (v4.14.8)."""
from __future__ import annotations

from typing import Any


def assess_orderability(row: dict[str, Any]) -> dict[str, Any]:
    """Return orderability flags and reasons for a normalized product row."""
    status = (row.get("status") or "ACTIVE").upper()
    published = row.get("published")
    online_visible = row.get("online_store_visible")
    variant_id = row.get("variant_id") or ""
    price = row.get("price") or ""
    available = row.get("available")
    availability = row.get("availability") or ""

    checkout_variant_valid = bool(variant_id and variant_id not in ("", "N/A"))
    has_price = bool(price and str(price).strip() not in ("", "N/A", "0", "0.00"))

    can_add = True
    reason = ""
    avail = availability or ("available" if available else "out_of_stock")

    if status in ("DRAFT", "ARCHIVED"):
        can_add = False
        avail = "not_available_for_checkout"
        reason = "Product exists in Shopify but is not active/published/checkout-ready."
    elif available is False or avail == "out_of_stock":
        can_add = False
        avail = "out_of_stock"
        reason = "Product is out of stock."
    elif published is False or online_visible is False:
        can_add = False
        avail = "not_available_for_checkout"
        reason = "Product exists in Shopify but is not published to the online store."
    elif not checkout_variant_valid:
        can_add = False
        avail = "not_available_for_checkout"
        reason = "Product has no valid checkout variant."
    elif not has_price:
        can_add = False
        avail = "not_available_for_checkout"
        reason = "Product has no confirmed price for checkout."

    return {
        "can_add_to_cart": can_add,
        "checkout_variant_valid": checkout_variant_valid,
        "unavailable_reason": reason,
        "availability": avail,
        "status": status,
        "published": published,
        "online_store_visible": online_visible,
    }
