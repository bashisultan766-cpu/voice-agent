"""
Deterministic fast input classifier for live voice commerce.

Returns instant spoken replies for greetings, smalltalk, vague product requests,
and email confirmation prompts. Routes real commerce work to the Main LLM Brain.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from ..state.models import SessionState

_ISBN = re.compile(r"\b(?:97[89]\d{10}|\d{9}[\dXx]|\d{13})\b")
_ORDER_NUM = re.compile(r"\b(?:order\s*)?#?\s*(\d{4,10})\b", re.I)
_YES = re.compile(
    r"^(?:yes|yeah|yep|yup|correct|that'?s right|that is right|affirmative|sure|ok(?:ay)?)\s*[.!]?\s*$",
    re.I,
)
_NO = re.compile(r"^(?:no|nope|nah|not really)\s*[.!]?\s*$", re.I)

_VAGUE_PRODUCT_UTTERANCES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^i need a book(?:\s+from you)?\.?$", re.I), "book"),
    (re.compile(r"^i want a book\.?$", re.I), "book"),
    (re.compile(r"^can i have a book\.?$", re.I), "book"),
    (re.compile(r"^i want to buy a book\.?$", re.I), "book"),
    (re.compile(r"^i need a magazine\.?$", re.I), "magazine"),
    (re.compile(r"^i need a newspaper\.?$", re.I), "newspaper"),
    (re.compile(r"^i want to (?:place an order|order something)\.?$", re.I), "generic"),
    (re.compile(r"^i need a book from you\.?$", re.I), "book"),
    (re.compile(r"^(?:something to read|i need something to read)\.?$", re.I), "book"),
    (re.compile(r"^(?:a book|book|books|a magazine|magazine|a newspaper|newspaper)\.?$", re.I), "category"),
]

_CLARIFY_BOOK = "Sure — what title, author, or ISBN are you looking for?"
_CLARIFY_MAGAZINE = "Sure — what magazine name are you looking for?"
_CLARIFY_NEWSPAPER = "Sure — what newspaper are you looking for?"
_CLARIFY_GENERIC = "Sure — what item are you looking for?"
_ISBN_PROMPT_REPLY = (
    "Yes, please go ahead and say the ISBN number or title magazine or newspaper."
)

_VAGUE_CATEGORY_TAILS = frozenset({
    "book", "a book", "books", "magazine", "a magazine", "magazines",
    "newspaper", "a newspaper", "newspapers", "something to read",
})

_INSTANT_SMALLTALK: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^(hi|hello|hey)( there| you)?[.!]?$", re.I),
     "This is SureShot Books. How can I help you today?"),
    (re.compile(r"^good (morning|afternoon|evening)( there)?[.!]?$", re.I),
     "This is SureShot Books. How can I help you today?"),
    (re.compile(r"^how are you( doing)?( today)?[.!]?$", re.I),
     "I'm doing well, thank you. What can I help you find today?"),
    (re.compile(r"^what(?:'s| is) your name[.!]?$", re.I),
     "I'm Eric with SureShot Books. What can I help you with?"),
    (re.compile(r"^are you (?:a )?real( person)?[.!]?$", re.I),
     "I'm Eric, your SureShot Books phone assistant. How can I help?"),
    (re.compile(r"^can you hear me[.!]?$", re.I),
     "Yes, I can hear you. What can I help you with?"),
]

_SEARCH_ACK = ""
_ORDER_ACK = ""


@dataclass
class ClassificationResult:
    """Result of fast deterministic classification."""

    action: str = "brain"  # instant | brain | ack_then_brain
    instant_reply: str = ""
    ack_reply: str = ""
    reason: str = ""
    skip_llm: bool = False
    skip_tools: bool = False
    is_product_search: bool = False
    is_order_lookup: bool = False
    is_refund_lookup: bool = False
    is_payment_flow: bool = False
    is_facility: bool = False
    use_strong_model: bool = False
    metadata: dict = field(default_factory=dict)


def normalize_speech_text(text: str) -> str:
    """Light normalization of STT output."""
    if not text:
        return ""
    cleaned = re.sub(r"\s+", " ", text.strip())
    return cleaned


def _normalize_smalltalk(text: str) -> str:
    cleaned = re.sub(r"[^\w\s]", " ", (text or "").lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def _has_specific_product_detail(text: str) -> bool:
    from ..agent_runtime.order_flow_state import order_intent_detected

    if order_intent_detected(text):
        return False
    if _ISBN.search(text):
        return True
    for pattern in (
        r"(?:called|named|titled)\s+(.+)",
        r"(?:looking for|search for|do you have|find)\s+(.+)",
        r"(?:i need|i want|can i have)\s+(.+)",
        r"(?:book named|book called)\s+(.+)",
    ):
        m = re.search(pattern, text, re.I)
        if not m:
            continue
        tail = re.sub(r"[^\w\s]", "", m.group(1).strip().lower())
        tail = re.sub(r"\s+", " ", tail).strip()
        if tail in _VAGUE_CATEGORY_TAILS:
            continue
        if tail.endswith(" from you"):
            tail = tail[: -len(" from you")].strip()
            if tail in _VAGUE_CATEGORY_TAILS:
                continue
        words = tail.split()
        if len(words) >= 2:
            return True
        if len(words) == 1 and words[0] not in (
            "book", "books", "magazine", "magazines", "newspaper", "newspapers",
        ):
            return True
    return False


def is_vague_product_request(utterance: str) -> bool:
    text = (utterance or "").strip()
    if not text or _ISBN.search(text):
        return False
    for pattern, _kind in _VAGUE_PRODUCT_UTTERANCES:
        if pattern.match(text):
            return True
    lower = re.sub(r"[^\w\s]", "", text.lower()).strip()
    if lower in _VAGUE_CATEGORY_TAILS:
        return True
    if re.match(
        r"^(?:i need|i want|can i have|looking for)\s+(?:a\s+)?(?:book|books)\s*$",
        text,
        re.I,
    ):
        return True
    if _has_specific_product_detail(text):
        return False
    return False


def resolve_product_clarification(utterance: str) -> str:
    text = (utterance or "").strip()
    lower = text.lower()
    for pattern, kind in _VAGUE_PRODUCT_UTTERANCES:
        if pattern.match(text):
            if kind == "book":
                return _CLARIFY_BOOK
            if kind == "magazine":
                return _CLARIFY_MAGAZINE
            if kind == "newspaper":
                return _CLARIFY_NEWSPAPER
            return _CLARIFY_GENERIC
    if re.search(r"\bmagazine\b", lower) and not re.search(r"\bnewspaper\b", lower):
        if not _has_specific_product_detail(text):
            return _CLARIFY_MAGAZINE
    if re.search(r"\bnewspaper\b", lower):
        if not _has_specific_product_detail(text):
            return _CLARIFY_NEWSPAPER
    if re.search(r"\bbook\b", lower) and not _has_specific_product_detail(text):
        return _CLARIFY_BOOK
    return _CLARIFY_GENERIC


def _yes_no_active_workflow(session: "SessionState | None", utterance: str) -> bool:
    if session is None:
        return False
    text = (utterance or "").strip()
    if not (_YES.match(text) or _NO.match(text)):
        return False

    if getattr(session, "awaiting_payment_email_confirmation", False):
        return True
    if getattr(session, "awaiting_payment_email", False):
        return True
    if getattr(session, "payment_flow_status", "") in (
        "awaiting_email_confirmation",
        "awaiting_send_confirmation",
        "awaiting_email",
    ):
        return True

    commerce_status = getattr(session, "commerce_flow_status", "") or "idle"
    if commerce_status not in ("idle", ""):
        return True
    if getattr(session, "awaiting_product_confirmation", False):
        return True
    if getattr(session, "commerce_pending_candidate", None):
        return True
    if getattr(session, "awaiting_not_found_escalation_email", False):
        return True
    if getattr(session, "awaiting_cart_confirmation", False):
        return True

    return False


def _is_isbn_digit_utterance(text: str) -> bool:
    """True when caller is dictating ISBN digits (full or partial)."""
    if _ISBN.search(text):
        return True
    stripped = re.sub(r"[\s.\-]", "", text)
    if len(stripped) >= 8 and stripped.isdigit() and stripped.startswith(("978", "979")):
        return True
    if re.search(r"\b97[89][\d\s.\-]{4,}\b", text):
        return True
    return False


def _is_product_search_request(text: str) -> bool:
    if _is_isbn_digit_utterance(text):
        return True
    if _has_specific_product_detail(text):
        return True
    if re.search(r"\b(game of thrones|atomic habits)\b", text, re.I):
        return True
    if re.search(r"\b(author|by)\s+\w+", text, re.I) and re.search(r"\bbook\b", text, re.I):
        return True
    return False


def _is_order_lookup(text: str) -> bool:
    from ..agent_runtime.order_flow_state import order_intent_detected

    if order_intent_detected(text):
        return True
    return bool(_ORDER_NUM.search(text)) or bool(
        re.search(r"\b(order status|where is my order|track(?:ing)?)\b", text, re.I)
    )


def _is_refund_lookup(text: str) -> bool:
    return bool(re.search(r"\b(refund|money back|returned payment)\b", text, re.I))


def _is_facility_question(text: str) -> bool:
    return bool(re.search(r"\b(facility|prison|jail|inmate|correctional)\b", text, re.I))


def _needs_strong_model(text: str, session: "SessionState | None") -> bool:
    lower = text.lower()
    if re.search(r"\b(and also|multiple|compare|both|several)\b", lower):
        if re.search(r"\b(book|title|isbn|magazine|newspaper)\b", lower):
            return True
    if _is_facility_question(text) and re.search(r"\b(why|explain|reject|return)\b", lower):
        return True
    if re.search(r"\b(refund|cancel)\b", lower) and _ORDER_NUM.search(text):
        return True
    return False


def classify(
    utterance: str,
    session: "SessionState | None" = None,
    *,
    turn_mode: str = "",
    twiml_greeting_already: bool = False,
) -> ClassificationResult:
    """
    Fast deterministic classifier.

    Returns instant replies for safe deterministic cases; otherwise routes to brain.
    """
    text = normalize_speech_text(utterance)
    if not text:
        return ClassificationResult(
            action="instant",
            instant_reply="I didn't catch that. Could you repeat that for me?",
            reason="empty_utterance",
            skip_llm=True,
            skip_tools=True,
        )

    if _yes_no_active_workflow(session, text):
        return ClassificationResult(
            action="brain",
            reason="active_workflow_yes_no",
            is_payment_flow=bool(
                getattr(session, "awaiting_payment_email_confirmation", False)
                or getattr(session, "payment_flow_status", "") not in ("idle", "", None)
            ),
        )

    # A. Instant smalltalk — no LLM, no tools
    norm = _normalize_smalltalk(text)
    for pattern, reply in _INSTANT_SMALLTALK:
        if pattern.match(text.strip()):
            if twiml_greeting_already and re.search(r"\b(hi|hello|hey)\b", norm):
                return ClassificationResult(
                    action="instant",
                    instant_reply="What can I help you find today?",
                    reason="greeting_after_twiml",
                    skip_llm=True,
                    skip_tools=True,
                )
            return ClassificationResult(
                action="instant",
                instant_reply=reply,
                reason="smalltalk",
                skip_llm=True,
                skip_tools=True,
            )

    if re.search(r"\b(hi|hello|hey)\b", norm) and re.search(r"\bhow are you\b", norm):
        if len(norm.split()) <= 8:
            reply = (
                "I'm doing well. What can I help you find today?"
                if twiml_greeting_already
                else "I'm doing well, thank you. What can I help you find today?"
            )
            return ClassificationResult(
                action="instant",
                instant_reply=reply,
                reason="greeting_how_are_you",
                skip_llm=True,
                skip_tools=True,
            )

    # B. ISBN/title offer prompt — deterministic, no LLM
    if re.search(
        r"\bcan i give (?:you )?(?:the )?"
        r"(?:isbn(?:\s+number)?(?:\s+of(?:\s+the)?\s+book)?|title|magazine|newspaper)s?\b",
        text,
        re.I,
    ):
        return ClassificationResult(
            action="instant",
            instant_reply=_ISBN_PROMPT_REPLY,
            reason="isbn_offer_prompt",
            skip_llm=True,
            skip_tools=True,
        )

    # C. Vague product — clarify, no Shopify
    if is_vague_product_request(text):
        return ClassificationResult(
            action="instant",
            instant_reply=resolve_product_clarification(text),
            reason="vague_product_request",
            skip_llm=True,
            skip_tools=True,
        )

    # Email confirmation deterministic path handled by payment FSM in runtime
    if (turn_mode or "").lower() == "email":
        return ClassificationResult(
            action="brain",
            reason="email_turn",
            is_payment_flow=True,
        )

    # D/E. Order / refund before product search — "information about the order" is not a catalog query.
    if _is_order_lookup(text):
        return ClassificationResult(
            action="brain",
            reason="order_lookup",
            is_order_lookup=True,
            use_strong_model=_needs_strong_model(text, session),
        )

    if _is_product_search_request(text) and not is_vague_product_request(text):
        return ClassificationResult(
            action="brain",
            reason="product_search",
            is_product_search=True,
            use_strong_model=_needs_strong_model(text, session),
        )

    if _is_refund_lookup(text):
        return ClassificationResult(
            action="brain",
            reason="refund_lookup",
            is_refund_lookup=True,
            use_strong_model=True,
        )

    if _is_facility_question(text):
        return ClassificationResult(
            action="brain",
            reason="facility_question",
            is_facility=True,
            use_strong_model=True,
        )

    if re.search(r"\b(payment\s*link|checkout|send\s+(?:me\s+)?(?:the\s+)?link)\b", text, re.I):
        return ClassificationResult(
            action="brain",
            reason="payment_request",
            is_payment_flow=True,
        )

    return ClassificationResult(
        action="brain",
        reason="default_brain",
        use_strong_model=_needs_strong_model(text, session),
    )
