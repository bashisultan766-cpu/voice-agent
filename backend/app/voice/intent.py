from __future__ import annotations
import asyncio
import re
from dataclasses import dataclass
from enum import Enum
from typing import Dict, Optional

from app.voice.latency import intent_timeout_secs


class Intent(str, Enum):
    GREETING = "greeting"
    FAREWELL = "farewell"
    PRODUCT_SEARCH = "product_search"
    ORDER_LOOKUP = "order_lookup"
    CHECKOUT = "checkout"
    RECOMMENDATION = "recommendation"
    EMAIL_CAPTURE = "email_capture"
    OTHER = "other"


@dataclass
class ExtractedEntities:
    product_query: Optional[str] = None
    order_number: Optional[str] = None
    email: Optional[str] = None
    isbn: Optional[str] = None


@dataclass
class IntentResult:
    intent: Intent
    confidence: float
    entities: ExtractedEntities
    is_instant: bool = False  # True → bypass LLM + tools entirely


@dataclass
class SafetyCheckResult:
    allowed: bool
    reason: Optional[str] = None


# ── Compiled patterns ─────────────────────────────────────────────────────────

_GREETING_RE = re.compile(
    r"^(hi|hello|hey|good morning|good afternoon|good evening|howdy)\b",
    re.IGNORECASE,
)
_FAREWELL_RE = re.compile(
    r"^(bye|goodbye|see you|take care|that'?s all|no thanks|no thank you|"
    r"thanks bye|thank you goodbye|i'm done|nothing else)\b",
    re.IGNORECASE,
)
_PRODUCT_RE = re.compile(
    r"\b(looking for|find|search|do you have|do you carry|is there|got any|show me|"
    r"price of|cost of|how much|want to know about|"
    r"book|books|novel|novels|isbn|title|author|hardcover|paperback|edition)\b",
    re.IGNORECASE,
)
_ORDER_RE = re.compile(
    r"\b(order|track|tracking|where is|where'?s my|status of|shipped|delivery|"
    r"package|what happened to|where are|my purchase|check my order|"
    r"order number|order #)\b",
    re.IGNORECASE,
)
_CHECKOUT_RE = re.compile(
    r"\b(buy|purchase|checkout|check out|payment|pay for|i want to buy|"
    r"i'?d like to buy|add to cart|place an order|complete my order|i'?ll take|"
    r"want to order)\b",
    re.IGNORECASE,
)
_RECOMMENDATION_RE = re.compile(
    r"\b(recommend|recommendation|suggest|suggestion|what do you have|"
    r"what'?s popular|best sellers?|bestsellers?|what should i|top books|trending|"
    r"most popular|what'?s good)\b",
    re.IGNORECASE,
)
_EMAIL_INTENT_RE = re.compile(
    r"\b(my email|email is|email address|send to|send it to)\b",
    re.IGNORECASE,
)

# ── Entity extraction patterns ─────────────────────────────────────────────────

_ISBN_RE = re.compile(
    r"\b(?:ISBN[-: ]?)?(97[89][\d -]{10,13}|\d{9}[\dXx])\b"
)
_EMAIL_ADDR_RE = re.compile(
    r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}"
)
_ORDER_NUM_RE = re.compile(
    r"(?:#\s*(\d{4,})|order\s+(?:number\s+)?#?\s*(\d{4,}))",
    re.IGNORECASE,
)
_QUERY_NOISE_RE = re.compile(
    r"\b(i|i'm|i am|can you|could you|please|looking for|find|search for|"
    r"do you have|do you carry|got any|show me|want|would like|like to|get|"
    r"a|an|the|some|any|me|us|your|is there|are there)\b",
    re.IGNORECASE,
)

# Exact short utterances that bypass LLM entirely
_INSTANT_TRIGGERS: Dict[str, Intent] = {
    "hi": Intent.GREETING,
    "hello": Intent.GREETING,
    "hey": Intent.GREETING,
    "good morning": Intent.GREETING,
    "good afternoon": Intent.GREETING,
    "good evening": Intent.GREETING,
    "howdy": Intent.GREETING,
    "bye": Intent.FAREWELL,
    "goodbye": Intent.FAREWELL,
    "see you": Intent.FAREWELL,
    "thanks bye": Intent.FAREWELL,
    "thank you goodbye": Intent.FAREWELL,
    "that's all": Intent.FAREWELL,
    "no thanks": Intent.FAREWELL,
    "no thank you": Intent.FAREWELL,
    "i'm done": Intent.FAREWELL,
}


def classify_intent(transcript: str) -> IntentResult:
    """
    Fast, rule-based intent classifier + entity extractor.
    Never calls an external API. Typical runtime: <2ms.

    Returns the dominant intent with a confidence score (0–1) and
    any entities extracted from the transcript text.
    """
    normalized = transcript.strip().lower().rstrip(".,!?")

    # Exact-match instant triggers — bypass LLM + tools entirely
    if normalized in _INSTANT_TRIGGERS:
        return IntentResult(
            intent=_INSTANT_TRIGGERS[normalized],
            confidence=1.0,
            entities=ExtractedEntities(),
            is_instant=True,
        )

    entities = _extract_entities(transcript)
    scores: Dict[Intent, float] = {}

    if _GREETING_RE.search(normalized):
        scores[Intent.GREETING] = 0.85

    if _FAREWELL_RE.search(normalized):
        scores[Intent.FAREWELL] = 0.85

    if _ORDER_RE.search(normalized):
        base = 0.80
        if entities.order_number or entities.email:
            base = 0.95
        scores[Intent.ORDER_LOOKUP] = base

    if _CHECKOUT_RE.search(normalized):
        scores[Intent.CHECKOUT] = 0.82

    if _RECOMMENDATION_RE.search(normalized):
        scores[Intent.RECOMMENDATION] = 0.78

    if _PRODUCT_RE.search(normalized):
        base = 0.75
        if entities.isbn:
            base = 0.97
        scores[Intent.PRODUCT_SEARCH] = base

    if _EMAIL_INTENT_RE.search(normalized) and entities.email:
        scores[Intent.EMAIL_CAPTURE] = 0.88

    if not scores:
        return IntentResult(
            intent=Intent.OTHER,
            confidence=0.50,
            entities=entities,
        )

    best = max(scores, key=lambda k: scores[k])
    return IntentResult(
        intent=best,
        confidence=scores[best],
        entities=entities,
    )


# ── Entity helpers ────────────────────────────────────────────────────────────

def _extract_entities(text: str) -> ExtractedEntities:
    isbn_m = _ISBN_RE.search(text)
    email_m = _EMAIL_ADDR_RE.search(text)
    order_m = _ORDER_NUM_RE.search(text)

    order_number: Optional[str] = None
    if order_m:
        # Prefer the inner captured digit group
        order_number = (order_m.group(1) or order_m.group(2) or "").strip() or None

    return ExtractedEntities(
        product_query=_extract_product_query(text) or None,
        order_number=order_number,
        email=email_m.group(0) if email_m else None,
        isbn=isbn_m.group(1) if isbn_m else None,
    )


def _extract_product_query(text: str) -> str:
    """Remove filler words and return the core search terms."""
    cleaned = _QUERY_NOISE_RE.sub(" ", text)
    cleaned = re.sub(r"\s+", " ", cleaned).strip().strip(".,!?")
    return cleaned if len(cleaned) >= 2 else ""


# ── Safety / policy ───────────────────────────────────────────────────────────

_BLOCKED_PATTERNS = (
    re.compile(r"\b(kill|murder|bomb|terrorist|suicide)\b", re.IGNORECASE),
    re.compile(r"\b(credit card number|ssn|social security)\b", re.IGNORECASE),
)


def check_safety_policy(transcript: str) -> SafetyCheckResult:
    """Fast local policy gate — no external API calls."""
    for pattern in _BLOCKED_PATTERNS:
        if pattern.search(transcript):
            return SafetyCheckResult(
                allowed=False,
                reason="policy_violation",
            )
    return SafetyCheckResult(allowed=True)


def extract_entities(transcript: str) -> ExtractedEntities:
    """Public entity extractor for parallel bootstrap."""
    return _extract_entities(transcript)


def entities_to_dict(entities: ExtractedEntities) -> Dict[str, str]:
    return {
        k: v for k, v in {
            "product_query": entities.product_query,
            "order_number": entities.order_number,
            "email": entities.email,
            "isbn": entities.isbn,
        }.items() if v
    }


async def classify_intent_async(transcript: str) -> IntentResult:
    """Run rule-based intent classification off the event loop with a budget."""
    try:
        async with asyncio.timeout(intent_timeout_secs()):
            return await asyncio.to_thread(classify_intent, transcript)
    except TimeoutError:
        entities = await asyncio.to_thread(extract_entities, transcript)
        return IntentResult(
            intent=Intent.OTHER,
            confidence=0.40,
            entities=entities,
        )


async def check_safety_policy_async(transcript: str) -> SafetyCheckResult:
    """Run safety policy check off the event loop."""
    return await asyncio.to_thread(check_safety_policy, transcript)
