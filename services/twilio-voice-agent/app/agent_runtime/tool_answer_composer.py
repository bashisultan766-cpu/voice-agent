"""Deterministic answers from tool facts (v4.14.4)."""
from __future__ import annotations

import re
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .fact_packet import FactPacket
    from ..workers.base import WorkerBundle


def _mask_email(email: str) -> str:
    if not email or "@" not in email:
        return email
    local, domain = email.split("@", 1)
    if len(local) <= 2:
        masked = local[0] + "***"
    else:
        masked = local[0] + "***" + local[-1]
    return f"{masked}@{domain}"


def _extract_product_facts(worker_bundle: "WorkerBundle") -> list[dict]:
    products = []
    for name in ("product_isbn", "product_search", "book_title_extractor"):
        result = worker_bundle.results.get(name)
        if not result or not result.success or not result.data:
            continue
        data = result.data
        title = data.get("title") or data.get("product_title") or ""
        price = data.get("price") or data.get("formatted_price") or ""
        if title:
            products.append({"title": title, "price": price})
    return products


def _extract_order_status(worker_bundle: "WorkerBundle") -> Optional[str]:
    result = worker_bundle.results.get("order_lookup")
    if not result or not result.success:
        return None
    data = result.data or {}
    status = data.get("status") or data.get("fulfillment_status") or data.get("order_status")
    return str(status) if status else None


def _extract_payment_message(session) -> Optional[str]:
    pfr = getattr(session, "payment_flow_result", {}) or {}
    if pfr.get("email_sent"):
        email = pfr.get("email") or getattr(session, "confirmed_email", "")
        masked = _mask_email(email) if email else "your email"
        return f"Your payment link is ready. I sent it to {masked}."
    if pfr.get("blocked"):
        return "I couldn't create the payment link yet. Let me confirm the cart and email first."
    if pfr.get("safe_message"):
        return str(pfr["safe_message"])
    return None


def compose_answer_from_tool_facts(
    intent: str,
    fact_packet: "FactPacket",
    worker_bundle: "WorkerBundle",
    session=None,
) -> Optional[str]:
    """Build a deterministic spoken answer from verified tool facts only."""
    if not fact_packet and not worker_bundle:
        return None

    if session is not None:
        payment_msg = _extract_payment_message(session)
        if payment_msg and intent in ("payment", "send_payment_link", "payment_flow"):
            return payment_msg

    products = _extract_product_facts(worker_bundle)
    if products:
        if len(products) == 1:
            p = products[0]
            price_part = f" The price is {p['price']}." if p.get("price") else ""
            return f"I found {p['title']}.{price_part} Would you like to add it to your order?"
        titles = [p["title"] for p in products[:3]]
        joined = ", ".join(titles[:-1]) + f", and {titles[-1]}" if len(titles) > 1 else titles[0]
        return f"I found a few options. The closest are {joined}. Which one would you like?"

    if intent in ("isbn_lookup", "isbn_search", "book_title_search", "book_search", "product_search"):
        for name in ("product_isbn", "product_search"):
            result = worker_bundle.results.get(name)
            if result and result.success is False:
                continue
            if result and result.data and result.data.get("not_found"):
                return (
                    "I don't see that book listed right now. "
                    "I can search another title or send this to customer service."
                )
        hints = fact_packet.safe_response_hints if fact_packet else []
        if hints:
            return hints[0]
        facts = fact_packet.customer_facing_facts if fact_packet else []
        if facts and "not found" in facts[0].lower():
            return (
                "I don't see that book listed right now. "
                "I can search another title or send this to customer service."
            )

    order_status = _extract_order_status(worker_bundle)
    if order_status:
        return f"I found your order. The status is {order_status}."
    if intent in ("order_lookup", "order_status"):
        ol = worker_bundle.results.get("order_lookup")
        if ol and not ol.success:
            return "I couldn't find that order with the details provided. Do you have the order number or email?"

    if fact_packet and fact_packet.safe_response_hints:
        return fact_packet.safe_response_hints[0]

    if fact_packet and fact_packet.customer_facing_facts:
        return fact_packet.customer_facing_facts[0]

    if fact_packet and fact_packet.blocked_reasons:
        return "I couldn't complete that request safely. Let me confirm a few details first."

    return None
