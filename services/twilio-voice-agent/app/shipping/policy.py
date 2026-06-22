"""Shipping policy and subtotal wording rules (v4.8)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


@dataclass
class ShippingContext:
    method: Optional[str] = None          # "Media Mail", "Priority Mail", "USPS", etc.
    amount: Optional[str] = None          # "$3.99"
    carrier: Optional[str] = None
    is_known: bool = False


def get_shipping_defaults() -> dict:
    return {
        "default_method": os.environ.get("SHIPPING_DEFAULT_METHOD", "Media Mail"),
        "alt_method": os.environ.get("SHIPPING_ALT_METHOD", "Priority Mail"),
        "calculation_mode": os.environ.get("SHIPPING_CALCULATION_MODE", "shopify_or_policy"),
        "media_mail_price": os.environ.get("SHIPPING_MEDIA_MAIL_PRICE", ""),
        "priority_mail_price": os.environ.get("SHIPPING_PRIORITY_MAIL_PRICE", ""),
        "require_destination": os.environ.get("SHIPPING_REQUIRE_DESTINATION", "true").lower() == "true",
    }


def format_subtotal_message(amount: str) -> str:
    """Always frame subtotals as before-shipping."""
    return (
        f"Your subtotal before shipping is {amount}. "
        "Subtotal does not include shipping."
    )


def format_shipping_message(ctx: ShippingContext) -> str:
    """Return the correct shipping sentence based on available data."""
    if ctx.is_known and ctx.amount and ctx.method:
        return f"Shipping is {ctx.amount} by {ctx.method}."
    if ctx.is_known and ctx.method and not ctx.amount:
        return f"The shipping method on this order is {ctx.method}."
    if ctx.is_known and ctx.amount:
        return f"Shipping is {ctx.amount}."
    return (
        "Shipping is not included yet and depends on the shipping method and destination."
    )


def extract_shipping_context(order_data: dict) -> ShippingContext:
    """
    Pull shipping method and amount from an order lookup result.

    Looks for shipping_method, shipping_title, carrier, and shipping amount.
    Never invents data.
    """
    ctx = ShippingContext()

    # Prefer explicit shipping_method field
    method = (
        order_data.get("shipping_method")
        or order_data.get("shipping_title")
        or order_data.get("carrier")
        or ""
    )
    if method:
        ctx.method = str(method)
        ctx.is_known = True

    # Shipping amount
    amount = order_data.get("shipping") or order_data.get("shipping_amount") or ""
    if amount and amount != "? ":
        raw = str(amount).strip()
        if raw and raw not in ("?", "? ", "0.00 ", "0.00"):
            ctx.amount = raw
            ctx.is_known = True

    # Carrier
    carrier = order_data.get("carrier") or ""
    if carrier:
        ctx.carrier = str(carrier)

    return ctx


def build_order_shipping_response(order_data: dict, customer_question: str = "") -> str:
    """
    Build the correct voice response about shipping method/cost from order data.
    Never says "Processing Fee".
    """
    ctx = extract_shipping_context(order_data)
    fulfilled = (order_data.get("fulfillment_status") or "").upper()
    shipped = fulfilled in ("FULFILLED", "PARTIALLY_FULFILLED")

    q = customer_question.lower()
    asking_method = any(w in q for w in ("media mail", "priority", "how did", "how did it ship", "ship by", "shipped by"))

    if asking_method and ctx.method:
        if shipped:
            return f"Your order shipped by {ctx.method}."
        return f"It has not shipped yet. The shipping method on the order is {ctx.method}."

    if asking_method and not ctx.method:
        return (
            "I do not see the shipping method clearly on this order. "
            "I can forward this to customer service."
        )

    return format_shipping_message(ctx)
