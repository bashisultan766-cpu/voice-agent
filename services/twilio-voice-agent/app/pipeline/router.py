"""
Deterministic intent and entity router for the voice pipeline.

Pure regex / keyword matching — no LLM, no I/O, runs in microseconds.
Optimised for a bookstore use-case: ISBN lookup, title/author search,
order and refund status, checkout, and escalation flows.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from ..tools.isbn import is_isbn, normalize_isbn

# ── Compiled patterns (module-level, compiled once) ────────────────────────────

_ISBN_PREFIX = re.compile(r"\b(?:isbn|i\s*s\s*b\s*n)\s*[\-:]?\s*", re.IGNORECASE)
_ORDER_NUM = re.compile(r"#?\s*(\d{3,6})\b")
_EMAIL_PAT = re.compile(r"[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}", re.IGNORECASE)

# Phone: require separators or +1 prefix to distinguish from ISBN-10 bare digits.
_PHONE_PAT = re.compile(
    r"(?:"
    r"\+1\d{10}"                                             # +15551234567
    r"|\+1[\s.\-]\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}"      # +1 (555) 123-4567
    r"|\(\d{3}\)[\s.\-]\d{3}[\s.\-]\d{4}"                  # (555) 123-4567
    r"|\d{3}[.\-]\d{3}[.\-]\d{4}"                           # 555-123-4567 / 555.123.4567
    r")",
)

_SPOKEN_NUMS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}
_SPOKEN_NUM_PAT = "|".join(_SPOKEN_NUMS)

# Quantity: number + unit word ("2 copies") or action verb + number ("send me 3").
_QTY_UNIT_PAT = re.compile(
    rf"\b(\d{{1,2}}|{_SPOKEN_NUM_PAT})\s+(?:copies|copy|books?|volumes?|items?)\b",
    re.IGNORECASE,
)
_QTY_ACTION_PAT = re.compile(
    rf"\b(?:send\s+me|add|want|need|get\s+me|i\s+want|i\.?d\s+like|"
    rf"order|take|quantity\s+(?:is\s+|of\s+)?)\s*(\d{{1,2}}|{_SPOKEN_NUM_PAT})\b",
    re.IGNORECASE,
)

_REFUND_WORDS = re.compile(
    r"\b(refund|return|money back|credit|reimburse|reimbursement|charge back)\b",
    re.IGNORECASE,
)
_ORDER_WORDS = re.compile(
    r"\b(order|where is|track|tracking|shipped|delivery|arrive|shipment|dispatch)\b",
    re.IGNORECASE,
)
_CHECKOUT_WORDS = re.compile(
    r"\b(buy|purchase|checkout|check out|add to cart|place an order|want to get|"
    r"i.ll take|i want to buy|i.d like to buy)\b",
    re.IGNORECASE,
)
_SEND_LINK_WORDS = re.compile(
    r"\b(send|email|payment link|send me|email me|text me|link)\b",
    re.IGNORECASE,
)
_PRODUCT_WORDS = re.compile(
    r"\b(book|novel|title|copy|do you have|looking for|find|search|got any|"
    r"have any|in stock|carry|available|any copies|looking to)\b",
    re.IGNORECASE,
)
_AUTHOR_WORDS = re.compile(
    r"\b(author|by|written by|books by|anything by|works by|titles by)\b",
    re.IGNORECASE,
)
_SHIPPING_WORDS = re.compile(
    r"\b(ship|shipping|deliver|delivery|arrive|arrival|transit|estimated|"
    r"when will|how long)\b",
    re.IGNORECASE,
)
_PRICE_WORDS = re.compile(
    r"\b(price|cost|how much|how much does|expensive|cheap|affordable|retail|pricing)\b",
    re.IGNORECASE,
)
_ESCALATE_WORDS = re.compile(
    r"\b(human|agent|person|manager|supervisor|speak to|talk to|real person|"
    r"live agent|representative|operator|staff|help me)\b",
    re.IGNORECASE,
)
_GREETING_WORDS = re.compile(
    r"^\s*(hi|hello|hey|good morning|good afternoon|good evening|howdy|greetings)\b",
    re.IGNORECASE,
)
_CONFIRM_YES = re.compile(
    r"^\s*(yes|yeah|yep|yup|correct|right|sure|absolutely|please|ok|okay|affirmative|"
    r"go ahead|sounds good|that.?s right)\s*[.!?]?\s*$",
    re.IGNORECASE,
)
_CONFIRM_NO = re.compile(
    r"^\s*(no|nope|nah|not really|never mind|cancel|don.?t|no thanks|"
    r"negative|that.?s wrong|incorrect)\s*[.!?]?\s*$",
    re.IGNORECASE,
)

_PREAMBLE = re.compile(
    r"^\s*(do you have|looking for|find|search for|got any|have any|"
    r"any books by|books by|written by|anything by|by|a copy of|copies of|"
    r"i.m looking for|i want|i.d like|can you find)\s+",
    re.IGNORECASE,
)


# ── Public interface ───────────────────────────────────────────────────────────

@dataclass
class IntentResult:
    intent: str
    confidence: float                    # 0.0 – 1.0
    entities: dict[str, str] = field(default_factory=dict)
    needs_filler: bool = False
    suggested_tools: list[str] = field(default_factory=list)


def detect(text: str, session=None) -> IntentResult:
    """
    Classify caller intent from raw transcribed text.

    Returns an IntentResult with the primary intent, a confidence score,
    and extracted entities (isbn, order_number, email, product_phrase).

    session is optional — may be used in future for state-based disambiguation.
    """
    t = text.strip()
    entities: dict[str, str] = {}

    # ── Entity extraction ──────────────────────────────────────────────────────
    isbn_val = _extract_isbn(t)
    if isbn_val:
        entities["isbn"] = isbn_val

    om = _ORDER_NUM.search(t)
    if om:
        entities["order_number"] = f"#{om.group(1)}"

    em = _EMAIL_PAT.search(t)
    if em:
        entities["email"] = em.group(0)

    ph = _extract_phone(t)
    if ph:
        entities["phone"] = ph

    qty = _extract_quantity(t)
    if qty is not None:
        entities["quantity"] = str(qty)

    # ── Intent detection (most-specific first) ─────────────────────────────────

    if entities.get("isbn") or _ISBN_PREFIX.search(t):
        return IntentResult(
            intent="isbn_search",
            confidence=0.95,
            entities=entities,
            needs_filler=True,
            suggested_tools=["search_products"],
        )

    if _REFUND_WORDS.search(t):
        return IntentResult(
            intent="refund_status",
            confidence=0.90,
            entities=entities,
            needs_filler=True,
            suggested_tools=["get_refund_status"],
        )

    if _ESCALATE_WORDS.search(t):
        return IntentResult(
            intent="escalation",
            confidence=0.92,
            entities=entities,
            needs_filler=False,
            suggested_tools=["escalate_to_human"],
        )

    # "send me the payment link" / "email me the link" → send_payment_link
    if _SEND_LINK_WORDS.search(t) and ("link" in t.lower() or "email" in t.lower()):
        return IntentResult(
            intent="send_payment_link",
            confidence=0.85,
            entities=entities,
            needs_filler=False,
            suggested_tools=["send_payment_link_email"],
        )

    if _ORDER_WORDS.search(t):
        return IntentResult(
            intent="order_lookup",
            confidence=0.88,
            entities=entities,
            needs_filler=True,
            suggested_tools=["lookup_order"],
        )

    if _CHECKOUT_WORDS.search(t):
        return IntentResult(
            intent="checkout_request",
            confidence=0.85,
            entities=entities,
            needs_filler=True,
            suggested_tools=["create_checkout_link"],
        )

    if _AUTHOR_WORDS.search(t):
        phrase = _extract_product_phrase(t)
        if phrase:
            entities["product_phrase"] = phrase
        return IntentResult(
            intent="author_search",
            confidence=0.85,
            entities=entities,
            needs_filler=True,
            suggested_tools=["search_products"],
        )

    if _PRODUCT_WORDS.search(t):
        phrase = _extract_product_phrase(t)
        if phrase:
            entities["product_phrase"] = phrase
        return IntentResult(
            intent="product_search",
            confidence=0.82,
            entities=entities,
            needs_filler=True,
            suggested_tools=["search_products"],
        )

    # Standalone email (no other signals) → caller is providing email for verification
    if entities.get("email") and not entities.get("order_number"):
        return IntentResult(
            intent="email_capture",
            confidence=0.80,
            entities=entities,
            needs_filler=False,
        )

    if _SHIPPING_WORDS.search(t):
        return IntentResult(
            intent="shipping_question",
            confidence=0.80,
            entities=entities,
            needs_filler=True,
            suggested_tools=["lookup_order"],
        )

    if _PRICE_WORDS.search(t):
        phrase = _extract_product_phrase(t)
        if phrase:
            entities["product_phrase"] = phrase
        return IntentResult(
            intent="price_question",
            confidence=0.78,
            entities=entities,
            needs_filler=True,
            suggested_tools=["search_products"],
        )

    if _GREETING_WORDS.search(t):
        return IntentResult(
            intent="greeting",
            confidence=0.90,
            entities=entities,
            needs_filler=False,
        )

    if _CONFIRM_YES.match(t):
        return IntentResult(
            intent="confirmation",
            confidence=0.92,
            entities={**entities, "polarity": "yes"},
        )
    if _CONFIRM_NO.match(t):
        return IntentResult(
            intent="confirmation",
            confidence=0.92,
            entities={**entities, "polarity": "no"},
        )

    return IntentResult(intent="unknown", confidence=0.0, entities=entities)


# ── Private helpers ────────────────────────────────────────────────────────────

def _extract_isbn(text: str) -> Optional[str]:
    """Attempt to extract and normalise an ISBN from raw text."""
    # Try after stripping a leading "isbn" keyword
    clean = _ISBN_PREFIX.sub("", text).strip()
    for candidate in (clean, text):
        try:
            normalized = normalize_isbn(candidate)
            if normalized and is_isbn(normalized):
                return normalized
        except Exception:
            pass
    return None


def _extract_phone(text: str) -> Optional[str]:
    """
    Extract a phone number from text when it has separators or a +1 prefix.

    Bare 10-digit strings are NOT matched to avoid ambiguity with ISBN-10.
    Returns digits only (10 or 11 digit string).
    """
    m = _PHONE_PAT.search(text)
    if not m:
        return None
    digits = re.sub(r"\D", "", m.group(0))
    if len(digits) == 11 and digits.startswith("1"):
        return digits
    if len(digits) == 10:
        return digits
    return None


def _extract_quantity(text: str) -> Optional[int]:
    """
    Extract an explicit quantity from text.

    Matches patterns like '2 copies', 'three books', 'send me 4', 'want one'.
    Returns an integer in [1, 99] or None if no quantity found.
    """
    for pat in (_QTY_UNIT_PAT, _QTY_ACTION_PAT):
        m = pat.search(text)
        if m:
            val = m.group(1).lower()
            if val.isdigit():
                n = int(val)
                if 1 <= n <= 99:
                    return n
            elif val in _SPOKEN_NUMS:
                return _SPOKEN_NUMS[val]
    return None


def _extract_product_phrase(text: str) -> str:
    """Strip intent preamble words to isolate the product / author search term."""
    clean = _PREAMBLE.sub("", text).strip().strip("?.!,")
    return clean[:80] if clean else ""
