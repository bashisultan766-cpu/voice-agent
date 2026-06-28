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
    for txn in transactions_list_from_graphql(transactions) or []:
        details = txn.get("paymentDetails") or {}
        if not isinstance(details, dict):
            continue
        raw = str(details.get("number") or details.get("last4") or "")
        digits = re.sub(r"\D", "", raw)
        if len(digits) >= 4:
            return digits[-4:]
    return ""


def transactions_list_from_graphql(raw: Any) -> list[dict[str, Any]]:
    """
    Normalize Shopify transaction payloads.

    Order.transactions is a list; Refund.transactions is an OrderTransactionConnection.
    """
    if not raw:
        return []
    if isinstance(raw, list):
        return [t for t in raw if isinstance(t, dict)]
    if isinstance(raw, dict):
        if raw.get("edges") is not None:
            return [
                e.get("node") or {}
                for e in (raw.get("edges") or [])
                if isinstance(e, dict) and e.get("node")
            ]
        if raw.get("nodes") is not None:
            return [n for n in (raw.get("nodes") or []) if isinstance(n, dict)]
    return []


def customer_display_name(customer: dict[str, Any] | None) -> str:
    if not customer:
        return ""
    first = (customer.get("firstName") or "").strip()
    last = (customer.get("lastName") or "").strip()
    return f"{first} {last}".strip()
