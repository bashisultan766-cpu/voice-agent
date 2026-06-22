"""
Deterministic intent and entity router for the voice pipeline.

Pure regex / keyword matching — no LLM, no I/O, runs in microseconds.
Optimised for a bookstore use-case with inmate/facility support:
  ISBN lookup, title/author search, order and refund status,
  checkout, facility approval, email capture/correction/confirmation,
  multi-book orders, cancellation, and escalation flows.

v4.1 additions:
  - email_provided, email_correction, email_confirmation intents
  - multi_book_order, quantity_update intents
  - facility_approval, facility_restriction intents
  - refund_detail, cancellation_request, address_update intents
  - book_title_search (title-explicit search)
  - Improved product phrase extraction (handles "Game of Thrones" style)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from ..tools.isbn import is_isbn, normalize_isbn

# ── Compiled patterns (module-level, compiled once) ────────────────────────────

_ISBN_PREFIX = re.compile(r"\b(?:isbn|i\s*s\s*b\s*n)\s*[\-:]?\s*", re.IGNORECASE)
_ORDER_NUM = re.compile(r"(?<![a-z0-9])#?\s*(\d{3,6})\b(?![@.\-a-z0-9])", re.IGNORECASE)
_EMAIL_PAT = re.compile(r"[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}", re.IGNORECASE)

_PHONE_PAT = re.compile(
    r"(?:"
    r"\+1\d{10}"
    r"|\+1[\s.\-]\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}"
    r"|\(\d{3}\)[\s.\-]\d{3}[\s.\-]\d{4}"
    r"|\d{3}[.\-]\d{3}[.\-]\d{4}"
    r")",
)

_SPOKEN_NUMS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}
_SPOKEN_NUM_PAT = "|".join(_SPOKEN_NUMS)

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
# Refund detail questions — ask about specific amounts, shipping, items, facility
_REFUND_DETAIL_WORDS = re.compile(
    r"\b(how much (was|is|did|will)|"
    r"was (shipping|the shipping) refunded|"
    r"did (i|you|they) refund (the )?shipping|"
    r"what (was|is|were) (refunded|the refund)|"
    r"refund (amount|reason|date|status)|"
    r"(item|book|title) refund|"
    r"partial refund|full refund|"
    r"why was .{0,30} refunded|"
    r"facility (reject|return|send back))\b",
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
# Explicit title search ("I need Game of Thrones", "the title is...")
_TITLE_EXPLICIT = re.compile(
    r"\b(i need|i want|i.d like|can you find|do you have|"
    r"looking for|the title is|called|titled|the book is)\b",
    re.IGNORECASE,
)
_SHIPPING_WORDS = re.compile(
    r"\b(ship|shipping|deliver|delivery|arrive|arrival|transit|estimated|"
    r"when will|how long)\b",
    re.IGNORECASE,
)
_SHIPPING_PRICE_WORDS = re.compile(
    r"\b(shipping (cost|price|fee|rates?|charge)|how much (is|does) (shipping|delivery)|"
    r"cost to (ship|deliver))\b",
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

# Email-related intents
_EMAIL_CORRECTION_WORDS = re.compile(
    r"\b(no that.?s (wrong|not correct|incorrect)|"
    r"not correct|that.?s wrong|that.?s not right|"
    r"i said|change (it|the email) to|start again|"
    r"wrong email|incorrect email|"
    r"no[,.]?\s*try again|that.?s not my email)\b",
    re.IGNORECASE,
)
_EMAIL_CONFIRMATION_WORDS = re.compile(
    r"^\s*(yes|yeah|yep|correct|right|that.?s (right|correct|it)|"
    r"sounds? (right|correct|good)|perfect|exactly|confirmed?|"
    r"that.?s my email|yes that.?s correct)\b",
    re.IGNORECASE,
)
# Spoken email fragments — catches all live ASR variants:
#   "at gmail dot com", "at the rate gmail", "activate gmail",
#   "b a s h i at...", "dot com" (fragment completion), "my email"
_SPOKEN_EMAIL_WORDS = re.compile(
    r"\b("
    r"at\s+\w+\s+dot\s+(com|net|org|edu|gov|io|me)|"   # "at gmail dot com"
    r"at the rate\s+\w+|"                                 # "at the rate gmail"
    r"activate\s+\w+|"                                    # "activate g mail"
    r"\w+\s+at\s+\w+|"                                   # "user at gmail"
    r"[a-z]\s+[a-z]\s+[a-z](\s+[a-z]){2,}.*\bat\b|"   # spelled-out letters
    r"dot\s+(com|net|org|edu|gov|io|me)|"                # "dot com" fragment
    r"my email"
    r")\b",
    re.IGNORECASE,
)

# AT-word variants used in the spoken email detection condition
_AT_VARIANT_PAT = re.compile(
    r"\b(at|activate|at the rate)\b",
    re.IGNORECASE,
)

# Facility / inmate patterns
_FACILITY_KEYWORD = re.compile(
    r"\b(jail|prison|facility|correctional|detention|penitentiary|"
    r"institution|DOC|BOP|county jail)\b",
    re.IGNORECASE,
)
_FACILITY_APPROVAL_WORDS = re.compile(
    # Pattern A: facility keyword then approval verb (within 50 chars)
    r"\b(jail|prison|facility|correctional|detention|penitentiary|"
    r"institution|DOC|BOP|county jail)\b.{0,50}"
    r"\b(approved?|allowed?|accept|ship|send|ok|okay|cleared?|listed?)\b"
    # Pattern B: approval verb then facility keyword (bidirectional)
    r"|\b(approved?|allowed?|accept|ship|send|cleared?)\b.{0,50}"
    r"\b(jail|prison|facility|correctional|detention|institution|DOC|BOP)\b"
    # Pattern C: do/does/will/can + facility + approval verb
    r"|\b(is|are|does|will|can|do)\b.{0,40}"
    r"\b(jail|prison|facility|correctional|institution|DOC)\b.{0,30}"
    r"\b(approved?|allowed?|accept|ship|cleared?)\b",
    re.IGNORECASE,
)
_FACILITY_RESTRICTION_WORDS = re.compile(
    r"\b(restrict|banned?|prohibited?|not allowed|can.t (send|ship)|"
    r"rejected?|denied?|returned? (by|from)|"
    r"facility (rules?|policy|policies|guidelines?|requirements?)|"
    r"(approved?|allowed?) (books?|titles?)|"
    r"which books? (can|are)|book (restrictions?|rules?)|"
    # Hardcover/softcover questions about a facility
    r"(hardcover|softcover|paperback).{0,30}(jail|prison|facility)|"
    r"(jail|prison|facility).{0,30}(hardcover|softcover|paperback))\b",
    re.IGNORECASE,
)

# Cancellation and address
_CANCEL_WORDS = re.compile(
    r"\b(cancel (my order|the order|it|this)|"
    r"i want to cancel|stop the order|don.t (send|ship)|"
    r"never mind (the|my) order)\b",
    re.IGNORECASE,
)
_ADDRESS_WORDS = re.compile(
    r"\b(change (my )?address|update (my )?address|"
    r"different address|new address|ship to (a )?different|"
    r"wrong address|address (is wrong|needs to change))\b",
    re.IGNORECASE,
)

# Quantity update (standalone)
_QTY_UPDATE_WORDS = re.compile(
    r"\b(i want|i.d like|change (the )?quantity|"
    r"make it|instead of|just|only)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b",
    re.IGNORECASE,
)

# Multi-book signals: "four books", "two different books", "multiple books"
_MULTI_BOOK_WORDS = re.compile(
    r"\b(multiple books?|several books?|a few books?|"
    r"different (books?|titles?)|two.{0,10}books?|three.{0,10}books?|"
    r"four.{0,10}books?|five.{0,10}books?|"
    r"[2-9] (different )?books?|"
    r"(two|three|four|five) (different |separate )?books?|"
    r"and (also|another|one more)|"
    r"separate (emails?|orders?|payments?))\b",
    re.IGNORECASE,
)

_PREAMBLE = re.compile(
    r"^\s*(do you have|looking for|find|search for|got any|have any|"
    r"any books by|books by|written by|anything by|by|a copy of|copies of|"
    r"i.m looking for|i want|i.d like|can you find|i need|the title is|"
    r"a book called|called|titled)\s+",
    re.IGNORECASE,
)


# ── Public interface ───────────────────────────────────────────────────────────

@dataclass
class IntentResult:
    intent: str
    confidence: float
    entities: dict[str, str] = field(default_factory=dict)
    needs_filler: bool = False
    suggested_tools: list[str] = field(default_factory=list)


def detect(text: str, session=None) -> IntentResult:
    """
    Classify caller intent from raw transcribed text.

    Returns IntentResult with primary intent, confidence, and extracted entities.
    session is optional — used for state-based disambiguation (e.g. email_capture).
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

    facility = _extract_facility(t)
    if facility:
        entities["facility_name"] = facility

    # ── Intent detection (most-specific first) ─────────────────────────────────

    if entities.get("isbn") or _ISBN_PREFIX.search(t):
        return IntentResult(
            intent="isbn_search", confidence=0.95, entities=entities,
            needs_filler=True, suggested_tools=["search_products"],
        )

    # Email correction must come before confirmation (more specific)
    if _EMAIL_CORRECTION_WORDS.search(t):
        return IntentResult(
            intent="email_correction", confidence=0.93, entities=entities,
        )

    # Email confirmation (caller says "yes that's correct" in email context)
    if _EMAIL_CONFIRMATION_WORDS.match(t.strip()) and session and getattr(session, "pending_email", ""):
        return IntentResult(
            intent="email_confirmation", confidence=0.93, entities=entities,
        )

    # Spoken email fragments: covers all live ASR variants.
    # Require AT-variant + dot for a full email, OR a standalone TLD suffix ("dot com")
    # to avoid false positives like "at the facility" or "dot (period) in a sentence".
    # Skip if a typed @email was already extracted — regex already captured it correctly.
    _already_typed_email = bool(
        entities.get("email") and "@" in str(entities.get("email", ""))
    )
    _at_dot_present = bool(_AT_VARIANT_PAT.search(t)) and (
        "dot" in t.lower() or "period" in t.lower()
    )
    _is_tld_suffix = bool(
        re.search(r"\bdot\s+(com|net|org|edu|gov|io|me)\b", t, re.IGNORECASE)
    )
    _has_my_email = "my email" in t.lower() and not _already_typed_email
    if (
        not _already_typed_email
        and _SPOKEN_EMAIL_WORDS.search(t)
        and (_at_dot_present or _is_tld_suffix or _has_my_email)
    ):
        from ..pipeline.email_capture import normalize_spoken_email
        normalized = normalize_spoken_email(t)
        if normalized:
            entities["email"] = normalized
            entities["email_raw"] = t
        else:
            # Normalizer returned None — may be a domain suffix fragment
            entities["email_raw"] = t
        return IntentResult(
            intent="email_provided", confidence=0.88, entities=entities,
        )

    # Typed email in text
    if entities.get("email") and not entities.get("order_number"):
        return IntentResult(
            intent="email_provided", confidence=0.85, entities=entities,
        )

    # Facility approval check
    if _FACILITY_APPROVAL_WORDS.search(t):
        return IntentResult(
            intent="facility_approval", confidence=0.88, entities=entities,
            needs_filler=True, suggested_tools=["get_facility_policy"],
        )

    # Facility restriction / book policy
    if _FACILITY_RESTRICTION_WORDS.search(t):
        return IntentResult(
            intent="facility_restriction", confidence=0.85, entities=entities,
            needs_filler=True, suggested_tools=["get_facility_policy"],
        )

    if _REFUND_DETAIL_WORDS.search(t):
        return IntentResult(
            intent="refund_detail", confidence=0.90, entities=entities,
            needs_filler=True, suggested_tools=["get_refund_status"],
        )

    if _REFUND_WORDS.search(t):
        return IntentResult(
            intent="refund_status", confidence=0.90, entities=entities,
            needs_filler=True, suggested_tools=["get_refund_status"],
        )

    if _ESCALATE_WORDS.search(t):
        return IntentResult(
            intent="escalation", confidence=0.92, entities=entities,
            suggested_tools=["escalate_to_human"],
        )

    if _CANCEL_WORDS.search(t):
        return IntentResult(
            intent="cancellation_request", confidence=0.90, entities=entities,
            needs_filler=True,
        )

    if _ADDRESS_WORDS.search(t):
        return IntentResult(
            intent="address_update", confidence=0.88, entities=entities,
            needs_filler=True,
        )

    if _SEND_LINK_WORDS.search(t) and ("link" in t.lower() or "email" in t.lower()):
        return IntentResult(
            intent="send_payment_link", confidence=0.85, entities=entities,
            suggested_tools=["send_payment_link_email"],
        )

    if _ORDER_WORDS.search(t):
        return IntentResult(
            intent="order_lookup", confidence=0.88, entities=entities,
            needs_filler=True, suggested_tools=["lookup_order"],
        )

    # Multi-book order (before checkout so it takes priority)
    if _MULTI_BOOK_WORDS.search(t):
        phrase = _extract_product_phrase(t)
        if phrase:
            entities["product_phrase"] = phrase
        return IntentResult(
            intent="multi_book_order", confidence=0.85, entities=entities,
            needs_filler=True, suggested_tools=["search_products"],
        )

    if _CHECKOUT_WORDS.search(t):
        return IntentResult(
            intent="checkout_request", confidence=0.85, entities=entities,
            needs_filler=True, suggested_tools=["create_checkout_link"],
        )

    if _AUTHOR_WORDS.search(t):
        phrase = _extract_product_phrase(t)
        if phrase:
            entities["product_phrase"] = phrase
        return IntentResult(
            intent="author_search", confidence=0.85, entities=entities,
            needs_filler=True, suggested_tools=["search_products"],
        )

    # Explicit title search ("I need Game of Thrones", "the title is...")
    if _TITLE_EXPLICIT.search(t):
        phrase = _extract_product_phrase(t)
        if phrase:
            entities["product_phrase"] = phrase
        return IntentResult(
            intent="book_title_search", confidence=0.84, entities=entities,
            needs_filler=True, suggested_tools=["search_products"],
        )

    if _PRODUCT_WORDS.search(t):
        phrase = _extract_product_phrase(t)
        if phrase:
            entities["product_phrase"] = phrase
        return IntentResult(
            intent="product_search", confidence=0.82, entities=entities,
            needs_filler=True, suggested_tools=["search_products"],
        )

    # Quantity update (standalone — not part of a larger order request)
    if _QTY_UPDATE_WORDS.search(t) and not _PRODUCT_WORDS.search(t):
        return IntentResult(
            intent="quantity_update", confidence=0.82, entities=entities,
        )

    if _SHIPPING_PRICE_WORDS.search(t):
        return IntentResult(
            intent="shipping_price", confidence=0.82, entities=entities,
            needs_filler=True,
        )

    if _SHIPPING_WORDS.search(t):
        return IntentResult(
            intent="shipping_question", confidence=0.80, entities=entities,
            needs_filler=True, suggested_tools=["lookup_order"],
        )

    if _PRICE_WORDS.search(t):
        phrase = _extract_product_phrase(t)
        if phrase:
            entities["product_phrase"] = phrase
        return IntentResult(
            intent="price_question", confidence=0.78, entities=entities,
            needs_filler=True, suggested_tools=["search_products"],
        )

    if _GREETING_WORDS.search(t):
        return IntentResult(intent="greeting", confidence=0.90, entities=entities)

    if _CONFIRM_YES.match(t):
        return IntentResult(
            intent="confirmation", confidence=0.92,
            entities={**entities, "polarity": "yes"},
        )
    if _CONFIRM_NO.match(t):
        return IntentResult(
            intent="confirmation", confidence=0.92,
            entities={**entities, "polarity": "no"},
        )

    return IntentResult(intent="unknown", confidence=0.0, entities=entities)


# ── Alias for backward compatibility ──────────────────────────────────────────

def detect_intent(text: str, session=None) -> IntentResult:
    """Alias for detect() — used by engine.py."""
    return detect(text, session)


# ── Private helpers ────────────────────────────────────────────────────────────

def _extract_isbn(text: str) -> Optional[str]:
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
    clean = _PREAMBLE.sub("", text).strip().strip("?.!,")
    return clean[:80] if clean else ""


def _extract_facility(text: str) -> Optional[str]:
    """
    Extract a facility/jail name if spoken.
    Returns the matched phrase (up to 60 chars) or None.
    """
    m = re.search(
        r"\b(?:at|for|from|the|to)\s+([A-Z][a-zA-Z\s]{2,30}(?:jail|prison|facility|"
        r"correctional|detention|institution|penitentiary))",
        text,
        re.IGNORECASE,
    )
    if m:
        return m.group(1).strip()[:60]
    return None
