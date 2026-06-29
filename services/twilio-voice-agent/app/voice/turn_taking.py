"""
Turn-taking policy for voice digit/email/ISBN collection (v4.8).

Prevents agent from interrupting the customer too early when they are
dictating ISBN numbers, order numbers, or email addresses.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass

# Defaults — overridden by Settings when classify_turn(settings=...) is passed
_DEFAULT_MIN_SILENCE_MS = 1200
_DEFAULT_DIGIT_SILENCE_MS = 2500
_DEFAULT_EMAIL_SILENCE_MS = 2500
_DEFAULT_ORDER_SILENCE_MS = 2500

_ISBN_DIGIT_PATTERN = re.compile(r"\b\d[\d\s\-]{6,}\b")
_EMAIL_FRAGMENT_PATTERN = re.compile(
    r"\b[a-z0-9._%+\-]+\s*(?:at|@)\s*[a-z0-9.\-]+|"
    r"\b[a-z0-9._%+\-]+\s+(?:dot|\.)\s+(?:com|net|org|edu|gov)\b",
    re.IGNORECASE,
)
_ORDER_FRAGMENT_PATTERN = re.compile(r"\b\d{3,}\b")
_WAIT_PHRASE = re.compile(
    r"\b(wait|hold on|one second|one moment|let me repeat|i repeat)\b",
    re.IGNORECASE,
)

_ISBN_CONTEXT_PAT = re.compile(
    r"\b(isbn|i\s+s\s+b\s+n|iouspl|ouspl|iuspl|ibsn|book number|barcode number|the number is)\b",
    re.IGNORECASE,
)
_NON_ISBN_DIGIT_PAT = re.compile(
    r"\b("
    r"gpt|openai|llm|l and m|model|version|4o|4\.13|11 model|one model|"
    r"why are you not using|not using llm|not using l and m"
    r")\b",
    re.IGNORECASE,
)
_ISBN_PERMISSION_PAT = re.compile(
    r"\b(?:can i|i will|i'll|let me|going to)\s+(?:please\s+)?(?:give|read|tell|provide)\s+(?:you\s+)?(?:the\s+)?"
    r"(?:isbn|i\s*s\s*b\s*n|iouspl|ouspl|iuspl)(?:\s+number)?(?:\s+of(?:\s+the)?\s+book)?\b",
    re.IGNORECASE,
)


def is_isbn_permission_question(text: str) -> bool:
    """Caller asking permission to read ISBN/title — not digit collection."""
    return bool(_ISBN_PERMISSION_PAT.search((text or "").strip()))


def should_collect_isbn(text: str, *, book_collection: bool = False) -> bool:
    """True only when transcript context indicates ISBN digit collection."""
    t = (text or "").strip()
    if not t:
        return False
    if is_isbn_permission_question(t):
        return False
    if _NON_ISBN_DIGIT_PAT.search(t):
        return False
    digits = "".join(c for c in t if c.isdigit())
    if len(digits) in (10, 13):
        return True
    if _ISBN_CONTEXT_PAT.search(t):
        return True
    if book_collection:
        if len(digits) >= 10:
            return True
        if re.search(r"\bthe number is\b", t, re.I) and len(digits) >= 3:
            return True
    return False


@dataclass
class TurnTakingContext:
    collecting_isbn: bool = False
    collecting_email: bool = False
    collecting_order: bool = False
    is_fragment: bool = False
    recommended_silence_ms: int = _DEFAULT_MIN_SILENCE_MS
    hold_response: bool = False
    hold_filler: str = ""


def _silence_thresholds(settings=None) -> dict[str, int]:
    if settings is not None:
        return {
            "min": getattr(settings, "VOICE_MIN_FINAL_SILENCE_MS", _DEFAULT_MIN_SILENCE_MS),
            "digit": getattr(settings, "VOICE_DIGIT_COLLECTION_SILENCE_MS", _DEFAULT_DIGIT_SILENCE_MS),
            "email": getattr(settings, "VOICE_EMAIL_COLLECTION_SILENCE_MS", _DEFAULT_EMAIL_SILENCE_MS),
            "order": getattr(settings, "VOICE_ORDER_COLLECTION_SILENCE_MS", _DEFAULT_ORDER_SILENCE_MS),
        }
    try:
        from ..config import get_settings
        s = get_settings()
        return {
            "min": s.VOICE_MIN_FINAL_SILENCE_MS,
            "digit": s.VOICE_DIGIT_COLLECTION_SILENCE_MS,
            "email": s.VOICE_EMAIL_COLLECTION_SILENCE_MS,
            "order": s.VOICE_ORDER_COLLECTION_SILENCE_MS,
        }
    except Exception:
        return {
            "min": _DEFAULT_MIN_SILENCE_MS,
            "digit": _DEFAULT_DIGIT_SILENCE_MS,
            "email": _DEFAULT_EMAIL_SILENCE_MS,
            "order": _DEFAULT_ORDER_SILENCE_MS,
        }


def classify_turn(
    text: str,
    intent: str = "",
    active_flow: str = "",
    isbn_buffer: str = "",
    settings=None,
) -> TurnTakingContext:
    """
    Analyse the customer's turn text and intent to determine if we should
    hold our response longer (the customer is still dictating digits or an email).

    Returns a TurnTakingContext with recommended_silence_ms and hold_response.
    """
    ctx = TurnTakingContext()
    text_lower = text.lower().strip()
    thresholds = _silence_thresholds(settings)

    if _WAIT_PHRASE.search(text_lower):
        ctx.hold_response = True
        ctx.is_fragment = True
        ctx.hold_filler = ""
        return ctx

    # Determine collection mode from intent/flow
    isbn_intents = {
        "isbn_collection_start", "isbn_search", "isbn_fragment",
    }
    email_intents = {
        "email_capture", "email_confirmation", "spell_email_request",
        "email_correction", "send_payment_link",
    }
    order_intents = {
        "order_status", "order_lookup", "refund_status",
        "cancellation_request", "tracking_inquiry",
    }

    in_isbn = intent in isbn_intents or "isbn" in active_flow or bool(isbn_buffer)
    in_email = intent in email_intents or "email" in active_flow
    in_order = intent in order_intents or "order" in active_flow

    # Override from text content — ISBN only with explicit context
    if should_collect_isbn(text_lower, book_collection="book" in active_flow or "isbn" in active_flow):
        in_isbn = True
    elif _ISBN_DIGIT_PATTERN.search(text_lower) and should_collect_isbn(text_lower):
        in_isbn = True
    if _EMAIL_FRAGMENT_PATTERN.search(text_lower):
        in_email = True
    if in_order and _ORDER_FRAGMENT_PATTERN.search(text_lower):
        in_order = True

    ctx.collecting_isbn = in_isbn
    ctx.collecting_email = in_email
    ctx.collecting_order = in_order

    # Check if this looks like a fragment (digits only, incomplete email, etc.)
    words = text_lower.split()
    all_digits = all(w.isdigit() or w == "-" for w in words) if words else False
    short_fragment = len(words) <= 4 and (all_digits or in_email or in_isbn)
    ctx.is_fragment = short_fragment

    if in_isbn:
        ctx.recommended_silence_ms = thresholds["digit"]
        if short_fragment:
            ctx.hold_response = True
            ctx.hold_filler = "Go ahead, I'm listening."
    elif in_email:
        ctx.recommended_silence_ms = thresholds["email"]
        if short_fragment:
            ctx.hold_response = True
            ctx.hold_filler = "Please continue."
    elif in_order:
        ctx.recommended_silence_ms = thresholds["order"]
    else:
        ctx.recommended_silence_ms = thresholds["min"]

    return ctx


def get_silence_threshold_ms(ctx: TurnTakingContext) -> int:
    return ctx.recommended_silence_ms


def is_complete_isbn(text: str) -> bool:
    """Return True when text contains a checksum-valid ISBN-10/ISBN-13."""
    from ..tools.isbn import extract_isbn_candidate
    from ..tools.isbn_validator import _sliding_window_isbn13, extract_digits

    if extract_isbn_candidate(text):
        return True
    digits = extract_digits(text)
    if len(digits) > 13:
        return _sliding_window_isbn13(digits) is not None
    return False


def is_complete_order_number(text: str) -> bool:
    """Return True if text contains a plausible order number (4+ digits)."""
    digits = "".join(c for c in text if c.isdigit())
    return len(digits) >= 4
