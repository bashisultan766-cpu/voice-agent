"""
NormalizeVoiceIntent — structured intent detection for unclear voice input.

Maps spoken/transcribed caller text to a SureShot Books support intent.
Does NOT answer the customer; returns structured JSON for the LLM only.

Treats "ordinary" as "order" when context is support/order/shipping/refund.
Never refuses normal SureShot words as medical requests.
"""
from __future__ import annotations

import json
import re
from typing import Optional

_VALID_INTENTS = frozenset({
    "order",
    "refund",
    "tracking",
    "payment_link",
    "facility",
    "inmate",
    "book_search",
    "cancellation",
    "address_update",
    "escalation",
    "unknown",
})

_ORDER_CONTEXT = re.compile(
    r"\b(order|ordinary|ordering|ordered|tracking|status|shipment|shipped|"
    r"delivery|refund|payment|card|subtotal|shipping|media mail|priority mail|"
    r"cancel|address|facility|inmate|book|isbn|title|author)\b",
    re.I,
)
_ORDINARY_AS_ORDER = re.compile(
    r"\b(ordinary|ordering)\b", re.I,
)
_MEDICAL = re.compile(
    r"\b(diagnos|symptom|medicine|medication|treatment|prescri|doctor|hospital|"
    r"health advice|medical advice)\b",
    re.I,
)

_INTENT_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("escalation", re.compile(
        r"\b(human|person|representative|customer service|speak to someone|"
        r"real person|agent|manager)\b", re.I)),
    ("refund", re.compile(
        r"\b(refund|refunded|money back|card refund|chargeback)\b", re.I)),
    ("tracking", re.compile(
        r"\b(track|tracking|where is my|shipped|shipment|delivery status)\b", re.I)),
    ("cancellation", re.compile(
        r"\b(cancel|cancellation|cancelled|void)\b.*\b(order)?\b|"
        r"\bcan i cancel\b", re.I)),
    ("address_update", re.compile(
        r"\b(change|update|correct|fix|replace)\b.*\b(address|shipping)\b|"
        r"\baddress update\b", re.I)),
    ("payment_link", re.compile(
        r"\b(payment link|pay link|send.*link|checkout link|secure link)\b", re.I)),
    ("facility", re.compile(
        r"\b(facility|prison|jail|correctional|approved to ship|approved list)\b", re.I)),
    ("inmate", re.compile(
        r"\b(inmate|prisoner|incarcerat|detainee)\b", re.I)),
    ("book_search", re.compile(
        r"\b(book|isbn|title|author|catalog|in stock|backorder|price of|"
        r"do you have|looking for|newspaper|magazine|subscription|usa today|"
        r"wall street journal|people magazine)\b", re.I)),
    ("order", re.compile(
        r"\b(order|ordinary|ordering|ordered|order number|my order|"
        r"i give you the order|i have order|check my order)\b", re.I)),
]


def normalize_voice_intent(text: str, *, context: str = "") -> str:
    """
    Return JSON string with normalized intent and hints for the LLM.
    Never raises.
    """
    raw = (text or "").strip()
    combined = f"{context} {raw}".strip().lower()

    if not raw:
        return json.dumps({
            "intent": "unknown",
            "confidence": "low",
            "normalized_phrase": raw,
            "hints": ["Ask what the caller needs help with."],
        })

    # Medical only when clearly medical — not for normal SureShot words.
    if _MEDICAL.search(raw) and not _ORDER_CONTEXT.search(combined):
        return json.dumps({
            "intent": "unknown",
            "confidence": "high",
            "normalized_phrase": raw,
            "off_domain": "medical",
            "hints": [
                "Politely redirect to SureShot Books support; do not give medical advice.",
            ],
        })

    normalized = raw
    if _ORDINARY_AS_ORDER.search(raw) and _ORDER_CONTEXT.search(combined):
        normalized = _ORDINARY_AS_ORDER.sub("order", raw, count=1)

    detected = "unknown"
    confidence = "medium"
    for intent, pattern in _INTENT_PATTERNS:
        if pattern.search(normalized) or pattern.search(combined):
            detected = intent
            confidence = "high"
            break

    if detected == "unknown" and _ORDER_CONTEXT.search(combined):
        detected = "order"
        confidence = "medium"

    hints: list[str] = []
    if detected == "order":
        hints.append("Ask for order number if missing, then call get_order.")
    elif detected == "refund":
        hints.append("Ask for order number if missing, then get_order or lookup_refund_status.")
    elif detected == "book_search":
        hints.append(
            "Call catalog_search before stating availability or price. "
            "Includes newspapers, magazines, and subscriptions."
        )
    elif detected == "facility":
        hints.append("Ask facility name/city/state if missing, then check_facility_approval.")
    elif detected == "payment_link":
        hints.append("Confirm email before send_payment_link or send_facility_payment_link.")
    elif detected == "address_update":
        hints.append("Call address_update_instructions; do not change address by voice.")
    elif detected == "cancellation":
        hints.append("Ask order number, then cancel_order_request.")
    elif detected == "escalation":
        hints.append("Call escalate_to_customer_service.")

    return json.dumps({
        "intent": detected if detected in _VALID_INTENTS else "unknown",
        "confidence": confidence,
        "normalized_phrase": normalized,
        "original_phrase": raw,
        "hints": hints,
        "do_not_answer_customer": True,
    })
