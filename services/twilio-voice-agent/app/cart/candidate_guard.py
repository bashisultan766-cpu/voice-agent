"""Guard product candidate persistence — block memory/vague queries (v4.7)."""
from __future__ import annotations

import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)

_BLOCKED_INTENTS = frozenset({
    "first_book_question",
    "selected_books_question",
    "cart_titles_question",
    "cart_summary_question",
    "isbn_memory_question",
    "memory_summary_question",
    "cart_count_question",
    "cart_review_question",
    "titles_question",
    "isbn_count_question",
    "not_found_question",
    "store_info_question",
    "greeting",
    "unknown",
    "order_lookup",
    "payment_status_question",
    "ending_thanks",
    "confirmation",
    "spell_email_request",
})

_ALLOWED_INTENTS = frozenset({
    "isbn_search",
    "explicit_title_search",
    "explicit_author_search",
    "explicit_subject_search",
    "product_search_selecting",
    "book_title_search",
    "author_search",
    "product_search",
    "multi_book_order",
    "price_question",
})

_GENERIC_QUERIES = frozenset({
    "book", "books", "a book", "the book", "title", "first book",
    "which book", "my order", "store", "name", "the title",
    "first book title", "which book i add first",
})

_GENERIC_PATTERNS = (
    re.compile(r"^\s*title\s*[.!?]?\s*$", re.I),
    re.compile(r"what is (?:the )?first book", re.I),
    re.compile(r"which book (?:did )?i add first", re.I),
    re.compile(r"first book title", re.I),
)

_MIN_SPECIFICITY_SCORE = 3


def _query_specificity_score(query: str) -> int:
    q = (query or "").strip().lower()
    if not q:
        return 0
    if q in _GENERIC_QUERIES:
        return 0
    for pat in _GENERIC_PATTERNS:
        if pat.search(q):
            return 0
    words = [w for w in re.split(r"\s+", q) if len(w) > 2]
    score = len(words)
    if re.search(r"\b(called|titled|named|about|author|isbn)\b", q):
        score += 2
    if len(q) >= 12:
        score += 1
    return score


def should_save_candidate(
    intent: str,
    query: str = "",
    *,
    is_isbn: bool = False,
) -> tuple[bool, str]:
    """
    Return (allowed, reason).

    ISBN search with valid product is always allowed when is_isbn=True.
    """
    q = (query or "").strip()
    q_lower = q.lower()

    if intent in _BLOCKED_INTENTS:
        return False, f"blocked_intent:{intent}"

    if q_lower in _GENERIC_QUERIES:
        return False, "generic_query"

    for pat in _GENERIC_PATTERNS:
        if pat.search(q):
            return False, "generic_query_pattern"

    if is_isbn:
        return True, "isbn_search"

    if intent in _ALLOWED_INTENTS:
        if intent == "product_search":
            if _query_specificity_score(q) < _MIN_SPECIFICITY_SCORE:
                return False, "low_specificity"
        return True, f"allowed_intent:{intent}"

    if intent == "isbn_search":
        return True, "isbn_search"

    return False, f"intent_not_allowed:{intent}"


def log_candidate_guard(
    allowed: bool,
    intent: str,
    query: str,
    call_sid: str = "",
) -> None:
    sid = (call_sid or "")[:6]
    q_log = (query or "")[:60]
    if allowed:
        logger.info(
            "candidate_guard_allowed intent=%s query=%s sid=%s",
            intent, q_log, sid,
        )
    else:
        logger.info(
            "candidate_guard_blocked intent=%s query=%s sid=%s",
            intent, q_log, sid,
        )
