"""Brief, natural spoken order summaries for live voice."""
from __future__ import annotations

from typing import Any

from ..email.speller import speak_email
from ..tools.shopify_tools import _is_refunded_order
from .money_speech import speak_money_field


def _inner_order(order_payload: dict[str, Any]) -> dict[str, Any]:
    if not order_payload.get("found"):
        return {}
    return order_payload.get("order") or {}


def _order_is_refunded(order_payload: dict[str, Any], inner: dict[str, Any]) -> bool:
    fin = str(
        inner.get("financial_status")
        or inner.get("order_status")
        or order_payload.get("financial_status")
        or ""
    ).upper()
    if "REFUND" in fin or "VOID" in fin:
        return True
    if _is_refunded_order(inner):
        return True
    refund_info = inner.get("refund_info") or {}
    if refund_info.get("refunded"):
        return True
    if inner.get("refunds") or refund_info.get("refunds"):
        return True
    pricing = inner.get("pricing") or {}
    total_raw = (pricing.get("total") or pricing.get("total_with_shipping") or "").strip()
    if total_raw.startswith("0") and (inner.get("refunds") or refund_info.get("refunds")):
        return True
    return False


def _product_count(inner: dict[str, Any]) -> int:
    count = int(inner.get("product_count") or 0)
    if count:
        return count
    items = inner.get("products") or inner.get("items") or []
    return sum(int(i.get("quantity") or 0) for i in items)


def _item_phrase(count: int) -> str:
    from .money_speech import speak_int

    if count == 1:
        return "one product"
    if count == 0:
        return "no products"
    return f"{speak_int(count)} products"


def compose_refunded_order_voice_reply(inner: dict[str, Any]) -> str:
    """Refunded orders: status, refund email, card last four only."""
    email = (
        inner.get("customer_email")
        or (inner.get("customer") or {}).get("email")
        or ""
    )
    payment = inner.get("payment") or {}
    card_last4 = (
        payment.get("card_last4")
        or inner.get("payment_card_last4")
        or ""
    )
    card_brand = (
        payment.get("card_brand")
        or inner.get("payment_card_brand")
        or "card"
    ).strip()

    parts = ["I found your order.", "The order status is refunded."]
    if email:
        parts.append(
            f"The refund notification was sent to {speak_email(email)}."
        )
    if card_last4:
        brand = card_brand if card_brand.lower() != "card" else "card"
        parts.append(
            f"Payment was made using the {brand} card ending in {card_last4}."
        )
    return " ".join(parts)


def compose_brief_order_voice_reply(order_payload: dict[str, Any]) -> str:
    """
    Default order-found script: item count, subtotal, shipping, total.
    Natural spoken currency; no addresses or line-item dumps.
    """
    if not order_payload.get("found"):
        return ""

    inner = _inner_order(order_payload)
    if not inner:
        return ""

    if _order_is_refunded(order_payload, inner):
        return compose_refunded_order_voice_reply(inner)

    pricing = inner.get("pricing") or {}
    subtotal_raw = (
        pricing.get("subtotal_before_shipping")
        or pricing.get("subtotal")
        or ""
    )
    shipping_raw = pricing.get("shipping") or ""
    total_raw = (
        pricing.get("total_with_shipping")
        or pricing.get("total")
        or ""
    )

    count = _product_count(inner)
    parts = [
        "I found your order.",
        f"It has {_item_phrase(count)}.",
    ]
    if subtotal_raw:
        parts.append(f"The subtotal is {speak_money_field(subtotal_raw)}.")
    if shipping_raw:
        parts.append(f"Shipping is {speak_money_field(shipping_raw)}.")
    if total_raw:
        parts.append(f"The total is {speak_money_field(total_raw)}.")
    return " ".join(parts)
