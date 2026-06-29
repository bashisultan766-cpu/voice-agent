"""Natural, professional spoken order summaries for live voice."""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Optional

from ..email.speller import speak_email
from ..tools.shopify_tools import _is_refunded_order
from .money_speech import speak_money_field, speak_int, parse_money_field

_DIGIT_WORDS = {
    "0": "zero",
    "1": "one",
    "2": "two",
    "3": "three",
    "4": "four",
    "5": "five",
    "6": "six",
    "7": "seven",
    "8": "eight",
    "9": "nine",
}


def speak_card_last4_slow(last4: str) -> str:
    """Speak card last four one digit at a time — easier to follow on a phone call."""
    digits = [c for c in (last4 or "") if c.isdigit()][-4:]
    if not digits:
        return ""
    return ", ".join(_DIGIT_WORDS.get(d, d) for d in digits)


def _should_speak_money(value: str) -> bool:
    if not (value or "").strip():
        return False
    amount, _ = parse_money_field(value)
    return amount > 0


def _inner_order(order_payload: dict[str, Any]) -> dict[str, Any]:
    if not order_payload.get("found"):
        return {}
    return order_payload.get("order") or {}


def load_order_inner_from_session(session: Any) -> dict[str, Any]:
    """Parse cached Shopify order JSON from the live session."""
    raw = (getattr(session, "order_context", "") or "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


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


def _product_lines(inner: dict[str, Any]) -> list[str]:
    items = inner.get("products") or inner.get("items") or []
    lines: list[str] = []
    for item in items:
        if _is_processing_fee_item(item):
            continue
        title = (item.get("title") or item.get("name") or "").strip()
        if not title:
            continue
        qty = int(item.get("quantity") or 1)
        if qty > 1:
            lines.append(f"{speak_int(qty)} copies of {title}")
        else:
            lines.append(title)
    return lines


def _products_natural_phrase(inner: dict[str, Any]) -> str:
    lines = _product_lines(inner)
    if not lines:
        count = int(inner.get("product_count") or 0)
        if count == 1:
            return "You have one product on this order."
        if count > 1:
            return f"You have {speak_int(count)} products on this order."
        return ""
    if len(lines) == 1:
        return f"You ordered {lines[0]}."
    if len(lines) == 2:
        return f"You ordered {lines[0]}, and {lines[1]}."
    return f"You ordered {', '.join(lines[:-1])}, and {lines[-1]}."


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


def _order_email(inner: dict[str, Any]) -> str:
    return (
        inner.get("customer_email")
        or (inner.get("customer") or {}).get("email")
        or ""
    ).strip()


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
    brand = card_brand if card_brand.lower() != "card" else "your card"
    slow = speak_card_last4_slow(card_last4)
    if refunded:
        return (
            f"The refund was sent back to your {brand}. "
            f"The last four digits on that card are {slow}."
        )
    return (
        f"Payment was made with your {brand}. "
        f"The last four digits are {slow}."
    )


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


def _pricing_natural_phrase(inner: dict[str, Any]) -> str:
    subtotal_raw, shipping_raw, total_raw = _pricing_fields(inner)
    parts: list[str] = []
    if subtotal_raw and _should_speak_money(subtotal_raw):
        parts.append(f"the subtotal is {speak_money_field(subtotal_raw)}")
    if shipping_raw and _should_speak_money(shipping_raw):
        parts.append(f"shipping is {speak_money_field(shipping_raw)}")
    if total_raw and _should_speak_money(total_raw):
        parts.append(f"the total is {speak_money_field(total_raw)}")
    if not parts:
        return ""
    if len(parts) == 1:
        return f"On this order, {parts[0]}."
    return f"On this order, {', '.join(parts[:-1])}, and {parts[-1]}."


def _fulfillment_phrase(inner: dict[str, Any]) -> str:
    status = (
        inner.get("fulfillment_status")
        or (inner.get("shipping") or {}).get("fulfillment_status")
        or ""
    ).strip().lower().replace("_", " ")
    if status:
        return f"Fulfillment is currently {status}."
    return ""


def _tracking_phrase(inner: dict[str, Any]) -> str:
    tracking = inner.get("tracking") or {}
    number = (tracking.get("tracking_number") or inner.get("tracking_number") or "").strip()
    carrier = (tracking.get("carrier") or inner.get("carrier") or "").strip()
    parts: list[str] = []
    if carrier:
        parts.append(f"The carrier is {carrier}")
    if number:
        spaced = ", ".join(number)
        parts.append(f"the tracking number is {spaced}")
    if not parts:
        return ""
    return "For shipping, " + ", and ".join(parts) + "."


def compose_refunded_order_voice_reply(inner: dict[str, Any]) -> str:
    """Refunded orders — customer name, products, totals, reason, refund email, card."""
    email = _order_email(inner)
    customer_name = _order_customer_name(inner)
    order_date = _speak_order_date(inner)
    refund_reason = _refund_reason_phrase(inner)

    parts = ["I found your order."]
    if customer_name:
        parts.append(f"This order is under {customer_name}.")
    parts.append("This order has been refunded.")
    if order_date:
        parts.append(f"It was originally placed on {order_date}.")
    product_line = _products_natural_phrase(inner)
    if product_line:
        parts.append(product_line)
    pricing_line = _pricing_natural_phrase(inner)
    if pricing_line:
        parts.append(pricing_line)
    if refund_reason:
        parts.append(f"The refund reason on file is: {refund_reason}.")
    if email:
        parts.append(
            f"The refund confirmation email was sent to {speak_email(email)}."
        )
    card_phrase = _payment_card_phrase(inner, refunded=True)
    if card_phrase:
        parts.append(card_phrase)
    return " ".join(parts)


def compose_brief_order_voice_reply(order_payload: dict[str, Any]) -> str:
    """Full automatic order disclosure — natural professional phone tone."""
    if not order_payload.get("found"):
        return ""

    inner = _inner_order(order_payload)
    if not inner:
        return ""

    if _order_is_refunded(order_payload, inner):
        return compose_refunded_order_voice_reply(inner)

    customer_name = _order_customer_name(inner)
    email = _order_email(inner)
    status = _financial_status_phrase(inner)
    order_date = _speak_order_date(inner)

    parts = ["I found your order."]
    if customer_name:
        parts.append(f"This order is under {customer_name}.")
    if email:
        parts.append(f"The verified email on this order is {speak_email(email)}.")
    if status:
        parts.append(f"The order status is {status}.")
    fulfill = _fulfillment_phrase(inner)
    if fulfill:
        parts.append(fulfill)
    if order_date:
        parts.append(f"It was placed on {order_date}.")
    product_line = _products_natural_phrase(inner)
    if product_line:
        parts.append(product_line)
    pricing_line = _pricing_natural_phrase(inner)
    if pricing_line:
        parts.append(pricing_line)
    tracking = _tracking_phrase(inner)
    if tracking:
        parts.append(tracking)
    card_phrase = _payment_card_phrase(inner, refunded=False)
    if card_phrase:
        parts.append(card_phrase)
    return " ".join(parts)


def compose_card_last4_reply(inner: dict[str, Any]) -> str:
    card_phrase = _payment_card_phrase(
        inner,
        refunded=_order_is_refunded({"found": True}, inner),
    )
    if card_phrase:
        return card_phrase
    return (
        "I don't see card details on this order in Shopify. "
        "Is there something else about the order I can help with?"
    )


def compose_order_followup_reply(inner: dict[str, Any], caller_text: str) -> Optional[str]:
    """Answer a focused follow-up about the order already on file this call."""
    import re

    text = (caller_text or "").lower()
    if not inner:
        return None

    if re.search(r"\b(?:last\s*(?:four|4)|card|credit\s*card|ending\s*in|digits?)\b", text):
        return compose_card_last4_reply(inner)
    if re.search(r"\b(?:refund(?:ed)?|money\s+back)\b", text):
        if _order_is_refunded({"found": True}, inner):
            reason = _refund_reason_phrase(inner)
            email = _order_email(inner)
            parts = ["This order has been refunded."]
            if reason:
                parts.append(f"The refund reason is {reason}.")
            if email:
                parts.append(
                    f"The refund email was sent to {speak_email(email)}."
                )
            card = _payment_card_phrase(inner, refunded=True)
            if card:
                parts.append(card)
            return " ".join(parts)
        return "This order does not show as refunded in Shopify."
    if re.search(r"\b(?:customer\s*name|who(?:'s| is) (?:this|the) order for)\b", text):
        name = _order_customer_name(inner)
        if name:
            return f"This order is under {name}."
        return "I don't have a customer name on this order."
    if re.search(r"\b(?:email|e-mail)\b", text):
        email = _order_email(inner)
        if email:
            return f"The email on this order is {speak_email(email)}."
        return "I don't see an email address on this order."
    if re.search(r"\b(?:product|book|item|what did (?:i|they|we) order)\b", text):
        line = _products_natural_phrase(inner)
        return line or "I don't have product names on this order."
    if re.search(r"\b(?:total|subtotal|shipping|amount|how much|price)\b", text):
        line = _pricing_natural_phrase(inner)
        return line or "I don't have pricing details on this order."
    if re.search(r"\b(?:repeat|what did you (?:say|find)|order details|summary)\b", text):
        return compose_brief_order_voice_reply({"found": True, "order": inner})
    return None
