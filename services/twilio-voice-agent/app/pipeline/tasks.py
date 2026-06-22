"""Intent constants and voice filler phrases for the pipeline."""
from __future__ import annotations

import random


class Intent:
    ISBN_SEARCH = "isbn_search"
    PRODUCT_SEARCH = "product_search"
    AUTHOR_SEARCH = "author_search"
    ORDER_LOOKUP = "order_lookup"
    REFUND_STATUS = "refund_status"
    CHECKOUT_REQUEST = "checkout_request"
    SEND_PAYMENT_LINK = "send_payment_link"
    EMAIL_CAPTURE = "email_capture"
    CONFIRMATION = "confirmation"
    ESCALATION = "escalation"
    SHIPPING_QUESTION = "shipping_question"
    PRICE_QUESTION = "price_question"
    GREETING = "greeting"
    UNKNOWN = "unknown"

    # Intents that typically trigger slow Shopify tool calls.
    TOOL_INTENTS: frozenset[str] = frozenset({
        ISBN_SEARCH,
        PRODUCT_SEARCH,
        AUTHOR_SEARCH,
        ORDER_LOOKUP,
        REFUND_STATUS,
        CHECKOUT_REQUEST,
        SHIPPING_QUESTION,
        PRICE_QUESTION,
    })


# Short, natural filler phrases per intent.
# Multiple phrases prevent repetition across turns.
_FILLERS: dict[str, list[str]] = {
    Intent.ISBN_SEARCH: [
        "Let me search the catalog for that ISBN.",
        "One moment while I look that up.",
    ],
    Intent.PRODUCT_SEARCH: [
        "Let me search the catalog for that.",
        "One moment while I look that up.",
        "Let me check what we have in stock.",
    ],
    Intent.AUTHOR_SEARCH: [
        "Let me check what we have by that author.",
        "One moment while I search our collection.",
    ],
    Intent.ORDER_LOOKUP: [
        "Sure, let me pull up that order.",
        "One moment while I look up your order.",
    ],
    Intent.REFUND_STATUS: [
        "Let me check on that refund for you.",
        "One moment while I look into the refund status.",
    ],
    Intent.CHECKOUT_REQUEST: [
        "Let me set that up for you.",
        "One moment while I prepare your checkout.",
    ],
    Intent.SHIPPING_QUESTION: [
        "Let me check on that for you.",
        "One moment while I look up the shipping details.",
    ],
    Intent.PRICE_QUESTION: [
        "Let me check the price on that.",
        "One moment while I look that up.",
    ],
}


def filler_for_intent(intent: str) -> str | None:
    """Return a random filler phrase for this intent, or None if none defined."""
    phrases = _FILLERS.get(intent)
    return random.choice(phrases) if phrases else None


def needs_filler(intent: str) -> bool:
    """True when this intent usually triggers a slow tool call."""
    return intent in Intent.TOOL_INTENTS
