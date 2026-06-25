"""Deterministic answers from tool facts (v4.14.5)."""
from __future__ import annotations

import re
from typing import TYPE_CHECKING, Optional

from ..voice.title_speech import spoken_book_title

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


def _extract_product_rows(worker_bundle: "WorkerBundle") -> list[dict]:
    products: list[dict] = []
    for name in ("product_isbn", "product_search", "book_title_extractor", "universal_catalog_search"):
        result = worker_bundle.results.get(name)
        if not result or not result.success or not result.data:
            continue
        data = result.data
        if data.get("results") and isinstance(data["results"], list):
            for row in data["results"][:5]:
                if isinstance(row, dict):
                    products.append(_row_from_dict(row, parent=data))
            continue
        products.append(_row_from_dict(data))
    return [p for p in products if p.get("title")]


def _row_from_dict(data: dict, parent: dict | None = None) -> dict:
    parent = parent or {}
    title = data.get("title") or data.get("product_title") or ""
    price = data.get("price") or data.get("formatted_price") or ""
    available = data.get("available")
    inventory = data.get("inventory_quantity") or data.get("inventory")
    out_of_stock = available is False
    if inventory is not None:
        try:
            out_of_stock = int(inventory) <= 0
        except (TypeError, ValueError):
            pass
    product_kind = (
        data.get("product_kind")
        or parent.get("product_kind")
        or data.get("product_type")
        or parent.get("product_type")
        or ""
    )
    publication_title = (
        data.get("publication_title")
        or parent.get("publication_title")
        or title
    )
    subscription_term = data.get("subscription_term") or parent.get("subscription_term") or ""
    delivery_frequency = data.get("delivery_frequency") or parent.get("delivery_frequency") or ""
    return {
        "title": title,
        "price": str(price).strip() if price else "",
        "out_of_stock": out_of_stock,
        "not_found": bool(data.get("not_found") or parent.get("not_found")),
        "variant_id": data.get("variant_id") or "",
        "product_kind": str(product_kind).lower() if product_kind else "",
        "publication_title": publication_title,
        "subscription_term": subscription_term,
        "delivery_frequency": delivery_frequency,
        "can_add_to_cart": data.get("can_add_to_cart", parent.get("can_add_to_cart", True)),
        "not_orderable": bool(data.get("not_orderable") or parent.get("not_orderable")),
    }


def _item_label(product_kind: str) -> str:
    kind = (product_kind or "").lower()
    if kind == "newspaper":
        return "newspaper"
    if kind == "magazine":
        return "magazine"
    if kind == "subscription":
        return "subscription"
    if kind == "book":
        return "book"
    return "item"


def _not_found_message(product: dict) -> str:
    label = _item_label(product.get("product_kind", ""))
    clean_title = product.get("publication_title") or product.get("title") or ""
    if label == "book" and not clean_title:
        return (
            "I don't see that book listed right now. "
            "I can take your email and send it to customer service so they can check availability."
        )
    if label == "item" and not clean_title:
        return (
            "I don't see that book listed right now. "
            "I can take your email and send it to customer service so they can check availability."
        )
    if not clean_title:
        clean_title = "that item"
    if label in ("newspaper", "magazine", "subscription"):
        return (
            f"I don't see {clean_title} listed right now. "
            "I can take your email and have customer service check it."
        )
    if label == "book":
        return (
            f"I don't see {clean_title} listed right now. "
            "I can take your email and send it to customer service so they can check availability."
        )
    return (
        f"I don't see {clean_title} listed right now. "
        "I can take your email and have customer service check it."
    )


def _format_non_orderable(product: dict) -> str:
    title = product.get("title") or product.get("publication_title") or "that item"
    return (
        f"I found {title} in the store data, but it does not look available for checkout right now. "
        "I can take your email and have customer service follow up."
    )


def _format_no_store_match(query: str) -> str:
    clean = query.strip() or "that item"
    return (
        f"I don't see {clean} in the store data I can access right now. "
        "I can take your email and have customer service check it."
    )


def _format_single_product(product: dict) -> str:
    if product.get("not_orderable") or product.get("can_add_to_cart") is False:
        return _format_non_orderable(product)
    title = spoken_book_title(product["title"])
    kind = product.get("product_kind", "")
    label = _item_label(kind)
    if product.get("not_found"):
        return _not_found_message(product)
    if product.get("out_of_stock"):
        return (
            f"I found {title}, but it looks out of stock right now. "
            "I can take your email and have customer service follow up if we can get it."
        )
    term_part = ""
    if kind == "subscription":
        term = product.get("subscription_term") or product.get("delivery_frequency") or ""
        if term:
            term_part = f" for {term}"
    price_part = f"The price is {product['price']}." if product.get("price") else (
        f"I found {title}, but I don't have a confirmed price from the store right now."
    )
    if product.get("price"):
        avail = "It looks available."
        if label in ("newspaper", "magazine"):
            return (
                f"I found {title}. {price_part} {avail} "
                f"Would you like me to add this {label} to your order?"
            )
        if kind == "subscription":
            return (
                f"I found {title}{term_part}. {price_part} "
                "Would you like me to add it to your order?"
            )
        return (
            f"I found {title}. {price_part} {avail} "
            "Would you like me to add it to your order?"
        )
    return price_part


def _format_multiple_products(products: list[dict]) -> str:
    parts = []
    for p in products[:3]:
        if p.get("price"):
            parts.append(f"{spoken_book_title(p['title'])} for {p['price']}")
        else:
            parts.append(spoken_book_title(p["title"]))
    if len(parts) == 1:
        joined = parts[0]
    elif len(parts) == 2:
        joined = f"{parts[0]} and {parts[1]}"
    else:
        joined = f"{parts[0]}, {parts[1]}, and {parts[2]}"
    return f"I found a few options. The closest are {joined}. Which one would you like?"


def _extract_payment_message(session) -> Optional[str]:
    pfr = getattr(session, "payment_flow_result", {}) or {}
    if pfr.get("email_sent"):
        email = pfr.get("email") or getattr(session, "confirmed_email", "")
        masked = _mask_email(email) if email else "your email"
        return (
            f"I sent the payment link to {masked}. When you open it, you can enter "
            "the facility and inmate details and complete the order."
        )
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
        if payment_msg and intent in (
            "payment", "send_payment_link", "payment_flow", "checkout_request",
        ):
            return payment_msg

    products = _extract_product_rows(worker_bundle)
    if products:
        if len(products) == 1 or intent in ("isbn_lookup", "isbn_search"):
            return _format_single_product(products[0])
        return _format_multiple_products(products)

    if intent in (
        "isbn_lookup", "isbn_search", "book_title_search", "book_search", "product_search",
        "newspaper_search", "magazine_search", "subscription_search", "catalog_product_search",
    ):
        for name in ("product_isbn", "product_search", "universal_catalog_search"):
            result = worker_bundle.results.get(name)
            if result and result.success is False:
                continue
            if result and result.data and result.data.get("not_found"):
                pub_title = result.data.get("publication_title") or result.data.get("query") or ""
                kind = result.data.get("product_kind") or ""
                if not kind and intent in ("isbn_lookup", "isbn_search", "book_title_search", "book_search"):
                    kind = "book"
                if pub_title and intent not in ("isbn_lookup", "isbn_search", "book_title_search", "book_search"):
                    return _format_no_store_match(pub_title)
                return _not_found_message({
                    "publication_title": pub_title,
                    "product_kind": kind,
                    "not_found": True,
                })
            if result and result.data and result.data.get("not_orderable"):
                return _format_non_orderable(result.data)
        hints = fact_packet.safe_response_hints if fact_packet else []
        if hints:
            return hints[0]
        facts = fact_packet.customer_facing_facts if fact_packet else []
        if facts and "not found" in facts[0].lower():
            return (
                "I don't see that item listed right now. "
                "I can take your email and have customer service check it."
            )

    from .customer_service_orchestrator import (
        compose_facility_answer,
        compose_order_answer,
        compose_refund_answer,
    )

    worker_facts = {
        name: (result.data or {})
        for name, result in worker_bundle.results.items()
        if getattr(result, "success", False) and result.data
    }
    if intent in ("order_lookup", "order_status"):
        order_answer = compose_order_answer(worker_facts)
        if order_answer:
            return order_answer
        ol = worker_bundle.results.get("order_lookup")
        if ol and not ol.success:
            return "I couldn't find that order with the details provided. Do you have the order number or email?"

    if intent == "refund_lookup":
        refund_answer = compose_refund_answer(worker_facts)
        if refund_answer:
            return refund_answer

    if intent in ("facility", "facility_approval", "facility_restriction"):
        return compose_facility_answer(worker_facts)

    if intent == "address_update":
        from .customer_service_orchestrator import compose_address_escalation
        return compose_address_escalation()

    if intent == "cart_count_question":
        if session is not None:
            from .commerce_session import get_commerce_session
            from .cart_orchestrator import cart_summary_text

            sid = getattr(session, "call_sid", "")
            if sid:
                return cart_summary_text(get_commerce_session(sid))

    if fact_packet and fact_packet.safe_response_hints:
        return fact_packet.safe_response_hints[0]

    if fact_packet and fact_packet.customer_facing_facts:
        return fact_packet.customer_facing_facts[0]

    if fact_packet and fact_packet.blocked_reasons:
        return "I couldn't complete that request safely. Let me confirm a few details first."

    return None
