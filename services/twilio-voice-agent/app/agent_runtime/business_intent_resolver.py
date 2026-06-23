"""
BusinessIntentResolver — Eric Commerce Brain Guarantee Layer (v4.14.3).

Deterministic business-intent handling before/after Main LLM for obvious
phone-commerce phrases. Does not replace the LLM; guarantees bookstore behavior.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .memory_packet import MemoryPacket
    from ..state.models import SessionState

ANSWER_IDENTITY = "My name is Eric. I'm with SureShot Books."
ANSWER_JOB = (
    "My job is to help you as the SureShot Books assistant. "
    "I can find books, check orders, help with shipping, payment links, refunds, "
    "and facility questions."
)
ANSWER_ASSISTANT_IDENTITY = (
    "Yes, I'm Eric, the SureShot Books assistant. "
    "I can help with books, orders, shipping, payment links, and facility questions."
)
ANSWER_COMPANY = (
    "SureShot Books is a bookstore service. We help customers find books, place orders, "
    "and handle book-related questions like shipping, payments, facilities, and order status."
)
ANSWER_COMPANY_PURPOSE = (
    "Our purpose is to help customers find and order books quickly, "
    "including regular book orders and facility-related book orders."
)
ANSWER_SELL = "SureShot Books helps customers find and order books."
ANSWER_VAGUE_BOOK = "Sure. Do you have the ISBN, title, author, or subject?"
ANSWER_ISBN_COLLECT = "Yes, please say the ISBN number."
ANSWER_ISBN_COLLECT_LONG = "Yes. Give me the ISBN number and I'll look it up for you."
ANSWER_TITLE_COLLECT = "Go ahead. Please say the full title."
ANSWER_OFF_DOMAIN = (
    "I mainly help with SureShot Books. "
    "If you want books about that topic, I can search our catalog."
)
ANSWER_BUSINESS_FALLBACK = (
    "I can help with that. Do you have the ISBN, title, author, order number, or email?"
)
ANSWER_GENERIC_REPEAT = "Could you say that one more time?"

_OFF_DOMAIN_ANSWER_VARIANTS = (
    ANSWER_OFF_DOMAIN.lower(),
    "i can help with sureshot books",
    "i'm here to help with sureshot books",
)

_IDENTITY_PAT = re.compile(
    r"\b(what(?:'s| is) your name|who are you|your name\??|tell me your name)\b",
    re.I,
)
_JOB_QUESTION_PAT = re.compile(
    r"\b("
    r"what(?:'s| is) your job|what do you do|what is your role|"
    r"what are you here for|what is your work"
    r")\b",
    re.I,
)
_JOB_PURPOSE_PAT = re.compile(r"\bwhat(?:'s| is) your purpose\b", re.I)
_ASSISTANT_IDENTITY_PAT = re.compile(
    r"\b("
    r"are you (?:the )?(?:\w+\s+){0,4}(?:book(?:store)? )?assistant|"
    r"you (?:are|'re) (?:the )?(?:\w+\s+){0,4}(?:book(?:store)? )?assistant|"
    r"bookstore assistant|sureshot books assistant"
    r")\b",
    re.I,
)
_COMPANY_QUESTION_PAT = re.compile(
    r"\b("
    r"what is sureshot books|what is your company|what(?:'s| is) your company|"
    r"what do you sell|do you sell books"
    r")\b",
    re.I,
)
_COMPANY_PURPOSE_PAT = re.compile(
    r"\b(purpose of sureshot|what is the purpose of sureshot|what is the purpose)\b",
    re.I,
)
_VAGUE_BOOK_PAT = re.compile(
    r"\b("
    r"i need(?:\s+a?)*\s*book\b|i want(?:\s+a?)*\s*book\b|"
    r"looking for(?:\s+a?)*\s*book\b|need to order(?:\s+a?)*\s*book\b|"
    r"i am looking for(?:\s+a?)*\s*book\b|"
    r"can you give me(?:\s+(?:the|a))?\s*book\b|"
    r"give me(?:\s+(?:the|a))?\s*book\b|"
    r"can you find(?:\s+me)?(?:\s+a)?\s*book(?:\s+for me)?\b|"
    r"find(?:\s+me)?(?:\s+a)?\s*book(?:\s+for me)?\b"
    r")\b",
    re.I,
)
_ISBN_COLLECTION_PAT = re.compile(
    r"\b("
    r"can i give you (?:the )?isbn|can i give (?:you )?(?:the )?isbn|"
    r"i can give you (?:the )?isbn|i will give isbn|i've got isbn|i have isbn|"
    r"by isbn\b|(?:the )?isbn number(?:\s+of(?:\s+the)?\s+book)?"
    r")\b",
    re.I,
)
_ISBN_PERMISSION_FIND_PAT = re.compile(
    r"\b(isbn|isbn number)\b.*\b(find|look up|lookup|search|look for)\b",
    re.I,
)
_TITLE_INCOMPLETE_PAT = re.compile(
    r"^\s*(?:the title(?: name)? is|book title is|i have title)\s*[.!?]?\s*$",
    re.I,
)
_TITLE_SEARCH_PAT = re.compile(
    r"\b(?:the title(?: name)? is|book title is|search for)\s+(.{2,})",
    re.I,
)
_TITLE_I_NEED_PAT = re.compile(
    r"\bi need\s+(?!a(?:\s+a)?\s*book\b|to\b|the book\b)(.{2,})",
    re.I,
)
_BOOK_TOPIC_PAT = re.compile(
    r"\b("
    r"books?\s+about|books?\s+on|books?\s+by|do you have books about|"
    r"looking for books about|search books about|find books about"
    r")\b",
    re.I,
)
_AUTHOR_SUBJECT_PAT = re.compile(
    r"\b("
    r"books by|do you have books about|"
    r"i need (?:a |an )?(?!a\b)\w{3,} (?:book|novel|books)|"
    r"i need islamic books|i need romance"
    r")\b",
    re.I,
)
_OFF_DOMAIN_PAT = re.compile(
    r"\b("
    r"match schedule|match information|live match|live score|who won|playoff|"
    r"tournament|league standings|stream live|weather|temperature|forecast|"
    r"president|election|politics|latest news|world news|current events|"
    r"how (?:do i|can i|to) make|recipe|cook|cooking tutorial|apple juice|onion juice|"
    r"cricket match|football match|soccer match|game schedule"
    r")\b",
    re.I,
)
_SPORTS_WITHOUT_BOOKS_PAT = re.compile(
    r"\b(football|soccer|cricket|basketball|baseball|hockey|tennis|match|game)\b",
    re.I,
)
_CART_COUNT_PAT = re.compile(
    r"\b(how many books?(?:\s+(?:are\s+)?in my cart)?|cart count|books in cart|"
    r"how many (?:books|items) (?:are )?in (?:my )?cart)\b",
    re.I,
)
_ACK_PAT = re.compile(
    r"^\s*(okay\.?|ok\.?|yeah\.?|yes\.?|mm-?hmm\.?|uh-?huh\.?|by that\.?|right\.?)\s*[.!?]?\s*$",
    re.I,
)
_WHITESPACE = re.compile(r"\s+")


@dataclass
class BusinessIntentResult:
    matched: bool
    intent: str
    response_mode: str
    confidence: float
    direct_answer: str | None
    tool_categories: list[str]
    expected_next: str | None
    reason: str
    normalized_text: str
    search_query: str = ""
    tool_entities: dict[str, str] = field(default_factory=dict)


def _normalize(text: str) -> str:
    return _WHITESPACE.sub(" ", (text or "").strip())


def _unmatched(text: str) -> BusinessIntentResult:
    return BusinessIntentResult(
        matched=False,
        intent="unknown",
        response_mode="direct_answer",
        confidence=0.0,
        direct_answer=None,
        tool_categories=[],
        expected_next=None,
        reason="no_match",
        normalized_text=text,
    )


def _matched(
    *,
    intent: str,
    response_mode: str,
    confidence: float,
    direct_answer: str | None,
    tool_categories: list[str] | None = None,
    expected_next: str | None = None,
    reason: str,
    normalized_text: str,
    search_query: str = "",
    tool_entities: dict[str, str] | None = None,
) -> BusinessIntentResult:
    return BusinessIntentResult(
        matched=True,
        intent=intent,
        response_mode=response_mode,
        confidence=confidence,
        direct_answer=direct_answer,
        tool_categories=list(tool_categories or []),
        expected_next=expected_next,
        reason=reason,
        normalized_text=normalized_text,
        search_query=search_query,
        tool_entities=dict(tool_entities or {}),
    )


def extract_isbn_from_text(text: str) -> str | None:
    """Extract a 10- or 13-digit ISBN-like number from caller text."""
    compact = re.sub(r"[\s-]", "", text or "")
    for match in re.finditer(r"\d{10,13}", compact):
        digits = match.group(0)
        if len(digits) in (10, 13):
            return digits
    return None


def _extract_title_query(text: str) -> str | None:
    match = _TITLE_SEARCH_PAT.search(text) or _TITLE_I_NEED_PAT.search(text)
    if not match:
        return None
    query = match.group(1).strip().strip('"\'').rstrip(".!?")
    if len(query) < 2:
        return None
    lowered = query.lower()
    if lowered in {"a book", "the book", "book", "books"}:
        return None
    if re.fullmatch(r"(?:a\s+)+book", lowered):
        return None
    if _VAGUE_BOOK_PAT.search(text):
        return None
    non_book = re.search(
        r"\b(address|order|refund|shipping|payment|cancel|update my|facility|inmate)\b",
        lowered,
    )
    if non_book:
        return None
    return query


def _extract_book_topic_query(text: str) -> str:
    for pat in (
        r"books?\s+about\s+(.+)",
        r"books?\s+on\s+(.+)",
        r"books?\s+by\s+(.+)",
        r"do you have books about\s+(.+)",
    ):
        match = re.search(pat, text, re.I)
        if match:
            return match.group(1).strip().rstrip(".!?")
    match = re.search(r"i need (?:a |an )?(.+?)(?:\s+book|\s+novel|\s+books)\b", text, re.I)
    if match:
        return match.group(1).strip().rstrip(".!?")
    return text.strip()


def _get_expected_next(
    session_state: Optional["SessionState"] = None,
    memory_packet: Optional["MemoryPacket"] = None,
) -> str:
    if session_state is not None and hasattr(session_state, "dialogue"):
        expected = getattr(session_state.dialogue, "expected_next", "") or ""
        if expected:
            return expected
    return ""


def _ack_prompt_for_expected(expected: str) -> str | None:
    key = (expected or "").lower()
    if key in {"isbn_number", "isbn_digits", "isbn_13_digits"}:
        return "Go ahead. Please say the ISBN number."
    if key == "book_title":
        return ANSWER_TITLE_COLLECT
    if key in {"book_identifier", "isbn_or_title_or_author", "title_or_isbn_or_subject", "isbn_or_title"}:
        return ANSWER_VAGUE_BOOK
    return None


def is_acknowledgment(text: str) -> bool:
    return bool(_ACK_PAT.match(_normalize(text)))


def is_generic_unknown_answer(answer: str) -> bool:
    lowered = (answer or "").lower()
    return (
        "didn't understand" in lowered
        or "didn't catch that" in lowered
        or "could you repeat that" in lowered
    )


def is_off_domain_signal(text: str) -> bool:
    normalized = _normalize(text)
    if _BOOK_TOPIC_PAT.search(normalized):
        return False
    if _OFF_DOMAIN_PAT.search(normalized):
        return True
    if _SPORTS_WITHOUT_BOOKS_PAT.search(normalized) and not re.search(
        r"\b(book|books|isbn|title|author|subject|order|shipping|payment|refund|facility|inmate)\b",
        normalized,
        re.I,
    ):
        return True
    return False


def resolve_business_intent(
    text: str,
    memory_packet: Optional["MemoryPacket"] = None,
    session_state: Optional["SessionState"] = None,
) -> BusinessIntentResult:
    """Resolve obvious bookstore/business intents without calling the LLM."""
    normalized = _normalize(text)
    if not normalized:
        return _unmatched(normalized)

    expected_next = _get_expected_next(session_state, memory_packet)

    if is_acknowledgment(normalized):
        prompt = _ack_prompt_for_expected(expected_next)
        if prompt:
            return _matched(
                intent="acknowledgment",
                response_mode="direct_answer",
                confidence=0.90,
                direct_answer=prompt,
                reason="ack_with_expected_next",
                normalized_text=normalized,
            )
        return _matched(
            intent="acknowledgment",
            response_mode="hold",
            confidence=0.85,
            direct_answer=None,
            reason="ack_hold",
            normalized_text=normalized,
        )

    isbn = extract_isbn_from_text(normalized)
    if isbn:
        return _matched(
            intent="isbn_lookup",
            response_mode="needs_tools",
            confidence=0.97,
            direct_answer=None,
            tool_categories=["isbn_lookup", "catalog_search"],
            reason="isbn_digits_present",
            normalized_text=normalized,
            search_query=isbn,
            tool_entities={"isbn": isbn, "raw_text": normalized},
        )

    title_query = _extract_title_query(normalized)
    if title_query:
        return _matched(
            intent="book_title_search",
            response_mode="needs_tools",
            confidence=0.94,
            direct_answer=None,
            tool_categories=["catalog_search"],
            reason="title_search",
            normalized_text=normalized,
            search_query=title_query,
            tool_entities={"product_phrase": title_query, "raw_text": normalized},
        )

    if _TITLE_INCOMPLETE_PAT.match(normalized):
        return _matched(
            intent="title_collection_start",
            response_mode="direct_answer",
            confidence=0.95,
            direct_answer=ANSWER_TITLE_COLLECT,
            expected_next="book_title",
            reason="title_collection_start",
            normalized_text=normalized,
        )

    if _ISBN_PERMISSION_FIND_PAT.search(normalized):
        return _matched(
            intent="isbn_collection_start",
            response_mode="direct_answer",
            confidence=0.94,
            direct_answer=ANSWER_ISBN_COLLECT_LONG,
            expected_next="isbn_number",
            reason="isbn_permission_with_find",
            normalized_text=normalized,
        )

    if _ISBN_COLLECTION_PAT.search(normalized):
        return _matched(
            intent="isbn_collection_start",
            response_mode="direct_answer",
            confidence=0.93,
            direct_answer=ANSWER_ISBN_COLLECT,
            expected_next="isbn_number",
            reason="isbn_collection_start",
            normalized_text=normalized,
        )

    if _VAGUE_BOOK_PAT.search(normalized):
        return _matched(
            intent="vague_book_request",
            response_mode="direct_answer",
            confidence=0.93,
            direct_answer=ANSWER_VAGUE_BOOK,
            expected_next="book_identifier",
            reason="vague_book_request",
            normalized_text=normalized,
        )

    if _CART_COUNT_PAT.search(normalized):
        return _matched(
            intent="cart_count_question",
            response_mode="needs_tools",
            confidence=0.92,
            direct_answer=None,
            tool_categories=["cart_memory"],
            reason="cart_count_question",
            normalized_text=normalized,
        )

    if _BOOK_TOPIC_PAT.search(normalized) or _AUTHOR_SUBJECT_PAT.search(normalized):
        query = _extract_book_topic_query(normalized)
        return _matched(
            intent="book_search",
            response_mode="needs_tools",
            confidence=0.92,
            direct_answer=None,
            tool_categories=["catalog_search"],
            reason="author_or_subject_search",
            normalized_text=normalized,
            search_query=query,
            tool_entities={"product_phrase": query, "raw_text": normalized},
        )

    if _IDENTITY_PAT.search(normalized):
        return _matched(
            intent="identity",
            response_mode="direct_answer",
            confidence=0.97,
            direct_answer=ANSWER_IDENTITY,
            reason="identity_question",
            normalized_text=normalized,
        )

    if _JOB_QUESTION_PAT.search(normalized) or (
        _JOB_PURPOSE_PAT.search(normalized)
        and not re.search(r"\b(sureshot|sure\s*shot|bookstore)\b", normalized, re.I)
    ):
        return _matched(
            intent="job_question",
            response_mode="direct_answer",
            confidence=0.96,
            direct_answer=ANSWER_JOB,
            reason="job_question",
            normalized_text=normalized,
        )

    if _ASSISTANT_IDENTITY_PAT.search(normalized):
        return _matched(
            intent="assistant_identity",
            response_mode="direct_answer",
            confidence=0.95,
            direct_answer=ANSWER_ASSISTANT_IDENTITY,
            reason="assistant_identity",
            normalized_text=normalized,
        )

    if _COMPANY_PURPOSE_PAT.search(normalized):
        return _matched(
            intent="company_purpose",
            response_mode="direct_answer",
            confidence=0.94,
            direct_answer=ANSWER_COMPANY_PURPOSE,
            reason="company_purpose",
            normalized_text=normalized,
        )

    if _COMPANY_QUESTION_PAT.search(normalized):
        if re.search(r"\bwhat do you sell\b", normalized, re.I):
            answer = ANSWER_SELL
        else:
            answer = ANSWER_COMPANY
        return _matched(
            intent="company_question",
            response_mode="direct_answer",
            confidence=0.93,
            direct_answer=answer,
            reason="company_question",
            normalized_text=normalized,
        )

    if is_off_domain_signal(normalized):
        return _matched(
            intent="off_domain",
            response_mode="direct_answer",
            confidence=0.91,
            direct_answer=ANSWER_OFF_DOMAIN,
            reason="off_domain",
            normalized_text=normalized,
        )

    return _unmatched(normalized)


def business_result_to_decision(result: BusinessIntentResult) -> dict:
    """Convert resolver output to MainLLMAgent decision dict."""
    boundary = "off_domain_redirect" if result.intent == "off_domain" else "in_domain"
    if result.intent == "book_search" and result.tool_categories:
        boundary = "book_topic_allowed"
    return {
        "response_mode": result.response_mode,
        "intent": result.intent,
        "confidence": result.confidence,
        "direct_answer": result.direct_answer or "",
        "tool_categories": list(result.tool_categories),
        "tool_reason": result.reason,
        "one_question_to_ask": "",
        "domain_boundary": boundary,
        "safety_flags": [],
        "memory_instruction": "",
        "expected_next": result.expected_next or "",
        "search_query": result.search_query,
        "tool_entities": dict(result.tool_entities),
    }


def context_aware_unknown_fallback(
    text: str,
    session_state: Optional["SessionState"] = None,
    sid: str = "?",
) -> dict:
    """Fallback when LLM returns unknown — avoid generic repeat when possible."""
    import logging

    logger = logging.getLogger(__name__)
    normalized = _normalize(text)
    lowered = normalized.lower()

    business = resolve_business_intent(text, session_state=session_state)
    if business.matched:
        return business_result_to_decision(business)

    if is_acknowledgment(normalized):
        return business_result_to_decision(business) if business.matched else {
            "response_mode": "hold",
            "intent": "acknowledgment",
            "confidence": 0.80,
            "direct_answer": "",
            "tool_categories": [],
            "tool_reason": "ack_hold",
            "one_question_to_ask": "",
            "domain_boundary": "in_domain",
            "safety_flags": [],
            "memory_instruction": "",
            "expected_next": "",
            "search_query": "",
            "tool_entities": {},
        }

    business_keywords = (
        "book", "isbn", "title", "author", "subject", "order",
        "shipping", "payment", "refund", "facility", "inmate",
    )
    if any(kw in lowered for kw in business_keywords):
        return {
            "response_mode": "direct_answer",
            "intent": "unknown",
            "confidence": 0.55,
            "direct_answer": ANSWER_BUSINESS_FALLBACK,
            "tool_categories": [],
            "tool_reason": "business_keyword_fallback",
            "one_question_to_ask": "",
            "domain_boundary": "in_domain",
            "safety_flags": [],
            "memory_instruction": "",
            "expected_next": "",
            "search_query": "",
            "tool_entities": {},
        }

    if is_off_domain_signal(normalized):
        return {
            "response_mode": "direct_answer",
            "intent": "off_domain",
            "confidence": 0.85,
            "direct_answer": ANSWER_OFF_DOMAIN,
            "tool_categories": [],
            "tool_reason": "off_domain_fallback",
            "one_question_to_ask": "",
            "domain_boundary": "off_domain_redirect",
            "safety_flags": [],
            "memory_instruction": "",
            "expected_next": "",
            "search_query": "",
            "tool_entities": {},
        }

    logger.info("generic_unknown_used sid=%s reason=no_semantic_signal", sid)
    return {
        "response_mode": "direct_answer",
        "intent": "unknown",
        "confidence": 0.20,
        "direct_answer": ANSWER_GENERIC_REPEAT,
        "tool_categories": [],
        "tool_reason": "no_semantic_signal",
        "one_question_to_ask": "",
        "domain_boundary": "in_domain",
        "safety_flags": [],
        "memory_instruction": "",
        "expected_next": "",
        "search_query": "",
        "tool_entities": {},
    }
