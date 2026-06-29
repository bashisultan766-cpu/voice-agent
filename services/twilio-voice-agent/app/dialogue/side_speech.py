"""Filter background / meta speech that is not a customer request."""
from __future__ import annotations

import re

_SIDE_SPEECH_PAT = re.compile(
    r"\b(?:"
    r"i don'?t want (?:him|her) to|is she|is he|all over the place|"
    r"not steady|you understand|start (?:all )?over|"
    r"see, (?:he|she)|want him to know"
    r")\b",
    re.I,
)
_START_OVER_PAT = re.compile(r"\bstart (?:all )?over\b", re.I)


def is_side_conversation(text: str) -> bool:
    """True when STT picked up talk not directed at the agent."""
    t = (text or "").strip()
    if not t:
        return False
    from ..agent_runtime.order_flow_state import extract_order_number, order_intent_detected

    if order_intent_detected(t) or extract_order_number(t):
        return False
    from ..agent_runtime.isbn_short_circuit import is_explicit_title_catalog_query

    if is_explicit_title_catalog_query(t):
        return False
    if re.search(r"\b(isbn|payment link|add to cart|how much)\b", t, re.I):
        return False
    return bool(_SIDE_SPEECH_PAT.search(t))


def side_speech_reply(text: str) -> str | None:
    if _START_OVER_PAT.search(text or ""):
        return (
            "Of course — let's start fresh. I can help you find a book, "
            "check an order, or send a payment link. What would you like to do?"
        )
    if is_side_conversation(text):
        return (
            "I'm here for SureShot Books — books, orders, or payment links. "
            "What can I help you with?"
        )
    return None
