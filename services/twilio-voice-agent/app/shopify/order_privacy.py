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


def card_brand_from_transactions(transactions: list[dict[str, Any]]) -> str:
    """Card network/brand from Shopify payment details (e.g. Visa, Mastercard)."""
    for txn in transactions_list_from_graphql(transactions) or []:
        details = txn.get("paymentDetails") or {}
        if not isinstance(details, dict):
            continue
        company = str(details.get("company") or "").strip()
        if company:
            return company
    return ""


def is_order_disclosure_verified(
    session: Any,
    *,
    order_number_provided: bool,
    email_filter: str | None = None,
    phone_filter: str | None = None,
    order_email: str = "",
) -> bool:
    """
    Whether PII (full email) may be spoken to the caller.

    Order-number lookup is treated as verified for voice commerce.
    Email/phone-only lookup requires a matching verified identifier.
    """
    if order_number_provided:
        return True
    order_email_norm = (order_email or "").strip().lower()
    if email_filter and order_email_norm:
        return email_filter.strip().lower() == order_email_norm
    if session and order_email_norm:
        if getattr(session, "verified_email", False):
            for attr in ("caller_email", "confirmed_email"):
                caller = (getattr(session, attr, "") or "").strip().lower()
                if caller and caller == order_email_norm:
                    return True
    if phone_filter and session:
        inbound = (getattr(session, "from_number", "") or "").strip()
        if getattr(session, "verified_phone", False) and inbound and phone_filter:
            return True
    return False


def sanitize_order_object(order_obj: dict[str, Any], *, verified: bool) -> dict[str, Any]:
    """Strip or mask sensitive fields when disclosure is not verified."""
    if verified or not order_obj:
        return order_obj
    out = dict(order_obj)
    email = (out.get("customer_email") or "").strip()
    if not email:
        cust = out.get("customer") or {}
        if isinstance(cust, dict):
            email = (cust.get("email") or "").strip()
    if email:
        masked = mask_email_for_voice(email)
        out["customer_email"] = masked
        out["email_masked"] = masked
        if isinstance(out.get("customer"), dict):
            out["customer"] = {**out["customer"], "email": masked}
    out["payment_card_last4"] = ""
    out["payment_card_brand"] = ""
    if isinstance(out.get("payment"), dict):
        out["payment"] = {
            **out["payment"],
            "card_last4": "",
            "card_brand": "",
        }
    refunds = []
    for refund in out.get("refunds") or []:
        r = dict(refund)
        if r.get("destination_email"):
            r["destination_email"] = mask_email_for_voice(str(r["destination_email"]))
        r["card_last4"] = ""
        r["card_brand"] = ""
        refunds.append(r)
    out["refunds"] = refunds
    if isinstance(out.get("refund_info"), dict):
        out["refund_info"] = {**out["refund_info"], "refunds": refunds}
    if out.get("notes"):
        out["notes"] = "[redacted — verify email or phone on the order]"
    if out.get("order_note"):
        out["order_note"] = "[redacted — verify email or phone on the order]"
    out["note_attributes"] = {}
    out["timeline_comments"] = []
    out["timeline_events"] = []
    out["timeline"] = []
    if isinstance(out.get("customer"), dict):
        out["customer"] = {
            **out["customer"],
            "shipping_address": {},
            "phone": "",
        }
    return out


def customer_display_name(customer: dict[str, Any] | None) -> str:
    if not customer:
        return ""
    first = (customer.get("firstName") or "").strip()
    last = (customer.get("lastName") or "").strip()
    return f"{first} {last}".strip()
