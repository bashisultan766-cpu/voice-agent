"""Safe order/refund fields for voice responses (v4.30)."""
from __future__ import annotations

import re
from typing import Any, Optional


def mask_email_for_voice(email: str) -> str:
    e = (email or "").strip().lower()
    if "@" not in e:
        return "***@***"
    local, domain = e.split("@", 1)
    if not local:
        return f"***@{domain}"
    return f"{local[0]}***@{domain}"


def card_last4_from_transactions(transactions: list[dict[str, Any]]) -> str:
    """Extract last 4 digits from Shopify card payment details — never full PAN."""
    for txn in transactions or []:
        details = txn.get("paymentDetails") or {}
        if not isinstance(details, dict):
            continue
        raw = str(details.get("number") or details.get("last4") or "")
        digits = re.sub(r"\D", "", raw)
        if len(digits) >= 4:
            return digits[-4:]
    return ""


def customer_display_name(customer: dict[str, Any] | None) -> str:
    if not customer:
        return ""
    first = (customer.get("firstName") or "").strip()
    last = (customer.get("lastName") or "").strip()
    return f"{first} {last}".strip()
