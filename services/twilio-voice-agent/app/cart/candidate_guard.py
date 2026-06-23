"""Guard product candidate persistence — block memory/vague queries (v4.10)."""
from __future__ import annotations

import logging
import re
from typing import Optional

from ..catalog.query_specificity import (
    is_generic_product_query,
    may_auto_save_candidate,
    score_product_query_specificity,
)

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
    "vague_book_request",
    "out_of_domain_question",
    "topic_book_search_offer",
    "identity_question",
    "small_talk",
    "job_question",
    "keepalive_question",
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
    "confirm_product",
    "add_to_cart",
})

_GENERIC_PATTERNS = (
    re.compile(r"^\s*title\s*[.!?]?\s*$", re.I),
    re.compile(r"what is (?:the )?first book", re.I),
    re.compile(r"which book (?:did )?i add first", re.I),
    re.compile(r"first book title", re.I),
)


def _query_specificity_score(query: str) -> int:
    return score_product_query_specificity(query).score


_IDENTITY_WORDS_PAT = re.compile(
    r"\b("
    r"assistant|agent|you are|your name|your job|sureshot|sureshort|showshort|"
    r"social book|support|short short book"
    r")\b",
    re.I,
)
_COMPLAINT_PAT = re.compile(
    r"\b(not working|why not responding|why are you not responding|what the hell)\b",
    re.I,
)


def should_save_candidate(
    intent: str,
    query: str = "",
    *,
    is_isbn: bool = False,
    action_gate_approved: bool = True,
    variant_id: str = "",
) -> tuple[bool, str]:
    """
    Return (allowed, reason).

    ISBN search with valid product is always allowed when is_isbn=True.
    """
    q = (query or "").strip()

    if not action_gate_approved:
        return False, "action_gate_not_approved"

    if _IDENTITY_WORDS_PAT.search(q):
        return False, "agent_identity_query"

    if _COMPLAINT_PAT.search(q):
        return False, "complaint_or_frustration"

    if intent in _BLOCKED_INTENTS:
        return False, f"blocked_intent:{intent}"

    if is_isbn:
        if variant_id or len(re.sub(r"\D", "", q)) >= 10:
            return True, "isbn_search"
        return False, "isbn_missing_variant"

    if is_generic_product_query(q):
        return False, "generic_query"

    for pat in _GENERIC_PATTERNS:
        if pat.search(q):
            return False, "generic_query_pattern"

    if intent in _ALLOWED_INTENTS:
        if intent in ("product_search", "book_title_search", "author_search"):
            if not may_auto_save_candidate(q, is_isbn=False):
                return False, "low_specificity"
        if intent == "topic_book_search_offer":
            return False, "subject_search_no_auto_candidate"
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
