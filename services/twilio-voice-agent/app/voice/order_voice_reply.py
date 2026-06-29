"""Brief, natural spoken order summaries for live voice."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from ..email.speller import speak_email
from ..tools.shopify_tools import _is_refunded_order
from .money_speech import speak_money_field, speak_int, parse_money_field


def _should_speak_money(value: str) -> bool:
    if not (value or "").strip():
        return False
    amount, _ = parse_money_field(value)
    return amount > 0


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


def _is_processing_fee_item(item: dict[str, Any]) -> bool:
    title = (item.get("title") or item.get("name") or "").lower()
    return "processing fee" in title


def _product_count(inner: dict[str, Any]) -> int:
    count = int(inner.get("product_count") or 0)
    items = inner.get("products") or inner.get("items") or []
    filtered = [i for i in items if not _is_processing_fee_item(i)]
    if filtered:
        return sum(int(i.get("quantity") or 0) for i in filtered)
    if count and items and any(_is_processing_fee_item(i) for i in items):
        return sum(
            int(i.get("quantity") or 0)
            for i in items
            if not _is_processing_fee_item(i)
        )
    if count:
        return count
    return sum(int(i.get("quantity") or 0) for i in items)


def _item_phrase(count: int) -> str:
    if count == 1:
        return "one product"
    if count == 0:
        return "no products"
    return f"{speak_int(count)} products"


def _speak_order_date(inner: dict[str, Any]) -> str:
    raw = (inner.get("order_date") or inner.get("created_at") or "")[:10]
    if not raw or len(raw) < 10:
        return ""
    try:
        dt = datetime.strptime(raw, "%Y-%m-%d")
        day = dt.day
        suffix = "th"
        if day % 10 == 1 and day != 11:
            suffix = "st"
        elif day % 10 == 2 and day != 12:
            suffix = "nd"
        elif day % 10 == 3 and day != 13:
            suffix = "rd"
        return f"{dt.strftime('%B')} {day}{suffix}, {dt.year}"
    except ValueError:
        return raw


def _financial_status_phrase(inner: dict[str, Any]) -> str:
    fin = str(
        inner.get("financial_status") or inner.get("order_status") or ""
    ).strip().lower()
    mapping = {
        "paid": "paid",
        "partially_paid": "partially paid",
        "partially paid": "partially paid",
        "pending": "pending payment",
        "authorized": "authorized",
        "refunded": "refunded",
        "partially_refunded": "partially refunded",
        "voided": "voided",
    }
    return mapping.get(fin, fin.replace("_", " ") if fin else "on file")


def _pricing_fields(inner: dict[str, Any]) -> tuple[str, str, str]:
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
    return subtotal_raw, shipping_raw, total_raw


def _order_customer_name(inner: dict[str, Any]) -> str:
    from ..dialogue.greeting import greeting_safe_name

    name = (
        inner.get("customer_name")
        or (inner.get("customer") or {}).get("name")
        or ""
    ).strip()
    return greeting_safe_name(name) or ""


def _payment_card_fields(inner: dict[str, Any]) -> tuple[str, str]:
    payment = inner.get("payment") or {}
    card_last4 = (
        payment.get("card_last4")
        or inner.get("payment_card_last4")
        or ""
    ).strip()
    card_brand = (
        payment.get("card_brand")
        or inner.get("payment_card_brand")
        or "card"
    ).strip()
    return card_last4, card_brand


def _payment_card_phrase(inner: dict[str, Any], *, refunded: bool = False) -> str:
    card_last4, card_brand = _payment_card_fields(inner)
    if not card_last4:
        return ""
    brand = card_brand if card_brand.lower() != "card" else "card"
    if refunded:
        return f"The refund was issued to the {brand} card ending in {card_last4}."
    return f"Payment was made using the {brand} card ending in {card_last4}."


def _refund_reason_phrase(inner: dict[str, Any]) -> str:
    refunds = inner.get("refunds") or (inner.get("refund_info") or {}).get("refunds") or []
    for refund in refunds:
        reason = (refund.get("reason") or refund.get("note") or "").strip()
        if not reason:
            continue
        if "processing fee" in reason.lower():
            continue
        return reason
    return ""


def compose_refunded_order_voice_reply(inner: dict[str, Any]) -> str:
    """Refunded orders: customer name, status, date, products, totals, reason, refund email."""
    email = (
        inner.get("customer_email")
        or (inner.get("customer") or {}).get("email")
        or ""
    )

    count = _product_count(inner)
    subtotal_raw, shipping_raw, total_raw = _pricing_fields(inner)
    order_date = _speak_order_date(inner)
    customer_name = _order_customer_name(inner)
    refund_reason = _refund_reason_phrase(inner)

    parts = ["I found your order."]
    if customer_name:
        parts.append(f"This order is under {customer_name}.")
    parts.append("The order status is refunded.")
    if order_date:
        parts.append(f"The order date is {order_date}.")
    parts.append(f"It has {_item_phrase(count)}.")
    if subtotal_raw and _should_speak_money(subtotal_raw):
        parts.append(f"The subtotal is {speak_money_field(subtotal_raw)}.")
    if shipping_raw and _should_speak_money(shipping_raw):
        parts.append(f"Shipping is {speak_money_field(shipping_raw)}.")
    if total_raw and _should_speak_money(total_raw):
        parts.append(f"The total is {speak_money_field(total_raw)}.")
    if refund_reason:
        parts.append(f"The refund reason is {refund_reason}.")
    if email:
        parts.append(
            f"The refund notification was sent to {speak_email(email)}."
        )
    card_phrase = _payment_card_phrase(inner, refunded=True)
    if card_phrase:
        parts.append(card_phrase)
    return " ".join(parts)


def _product_name_phrase(inner: dict[str, Any]) -> str:
    items = inner.get("products") or inner.get("items") or []
    names: list[str] = []
    for item in items:
        if _is_processing_fee_item(item):
            continue
        title = (item.get("title") or item.get("name") or "").strip()
        qty = int(item.get("quantity") or 1)
        if not title:
            continue
        if qty > 1:
            names.append(f"{speak_int(qty)} copies of {title}")
        else:
            names.append(title)
        if len(names) >= 3:
            break
    if not names:
        return ""
    if len(names) == 1:
        return f"The product is {names[0]}."
    return "The products include " + ", ".join(names[:-1]) + f", and {names[-1]}."


def _fulfillment_phrase(inner: dict[str, Any]) -> str:
    status = (
        inner.get("fulfillment_status")
        or (inner.get("shipping") or {}).get("fulfillment_status")
        or ""
    ).strip().lower().replace("_", " ")
    if status:
        return f"Fulfillment status is {status}."
    return ""


def _tracking_phrase(inner: dict[str, Any]) -> str:
    tracking = inner.get("tracking") or {}
    number = (tracking.get("tracking_number") or inner.get("tracking_number") or "").strip()
    carrier = (tracking.get("carrier") or inner.get("carrier") or "").strip()
    parts: list[str] = []
    if carrier:
        parts.append(f"Carrier is {carrier}.")
    if number:
        spaced = " ".join(number)
        parts.append(f"Tracking number is {spaced}.")
    return " ".join(parts)


def compose_brief_order_voice_reply(order_payload: dict[str, Any]) -> str:
    """
    Default order-found script: status, date, item count, subtotal, shipping, total.
    Natural spoken currency; no addresses, customer name, or processing fees.
    """
    if not order_payload.get("found"):
        return ""

    inner = _inner_order(order_payload)
    if not inner:
        return ""

    if _order_is_refunded(order_payload, inner):
        return compose_refunded_order_voice_reply(inner)

    subtotal_raw, shipping_raw, total_raw = _pricing_fields(inner)
    count = _product_count(inner)
    order_date = _speak_order_date(inner)
    status = _financial_status_phrase(inner)
    customer_name = _order_customer_name(inner)
    email = (
        inner.get("customer_email")
        or (inner.get("customer") or {}).get("email")
        or ""
    )

    parts = ["I found your order."]
    if customer_name:
        parts.append(f"This order is under {customer_name}.")
    if email:
        parts.append(f"The email on the order is {speak_email(email)}.")
    if status:
        parts.append(f"The order status is {status}.")
    fulfill = _fulfillment_phrase(inner)
    if fulfill:
        parts.append(fulfill)
    if order_date:
        parts.append(f"The order date is {order_date}.")
    product_line = _product_name_phrase(inner)
    if product_line:
        parts.append(product_line)
    else:
        parts.append(f"It has {_item_phrase(count)}.")
    if subtotal_raw and _should_speak_money(subtotal_raw):
        parts.append(f"The subtotal is {speak_money_field(subtotal_raw)}.")
    if shipping_raw and _should_speak_money(shipping_raw):
        parts.append(f"Shipping is {speak_money_field(shipping_raw)}.")
    if total_raw and _should_speak_money(total_raw):
        parts.append(f"The total is {speak_money_field(total_raw)}.")
    tracking = _tracking_phrase(inner)
    if tracking:
        parts.append(tracking)
    card_phrase = _payment_card_phrase(inner, refunded=False)
    if card_phrase:
        parts.append(card_phrase)
    return " ".join(parts)
