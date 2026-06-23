"""Product query specificity scoring (v4.10).

Blocks generic book phrases from Shopify search and candidate persistence.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum

from ..tools.isbn import is_isbn, normalize_isbn


class QuerySpecificityLevel(str, Enum):
    GENERIC = "generic"
    SUBJECT = "subject"
    AUTHOR = "author"
    EXPLICIT_TITLE = "explicit_title"
    ISBN = "isbn"


@dataclass(frozen=True)
class QuerySpecificity:
    score: int
    level: QuerySpecificityLevel
    is_searchable: bool
    may_save_candidate: bool
    reason: str = ""


_GENERIC_EXACT = frozenset({
    "book", "books", "a book", "the book", "my book", "this book", "that book",
    "another book", "any book", "some books", "i need a book", "i want a book",
    "help me find a book", "do you sell books", "title", "author", "something",
    "order", "payment", "bill", "link",
    "can you provide", "please provide", "can you please provide",
})

# Non-product phrases — block catalog search but are not vague book requests
_NON_PRODUCT_PHRASES = frozenset({
    "hello", "how are you", "what is your name", "where are you from",
})

_GENERIC_PATTERNS = (
    re.compile(r"^\s*books?\s*[.!?]?\s*$", re.I),
    re.compile(r"^\s*(?:a |the |my |this |that |another |any )?books?\s*[.!?]?\s*$", re.I),
    re.compile(r"^\s*i (?:need|want) (?:a |the )?books?\s*[.!?]?\s*$", re.I),
    re.compile(r"^\s*i (?:need|want) (?:a |the )?books?\s*[.!?]?\s*$", re.I),
    re.compile(r"^\s*(?:can you|could you|please) (?:provide|give|send)\s*[.!?]?\s*$", re.I),
    re.compile(r"^\s*title\s*[.!?]?\s*$", re.I),
    re.compile(r"what is (?:the )?first book", re.I),
    re.compile(r"which book (?:did )?i add first", re.I),
    re.compile(r"first book title", re.I),
)

_SUBJECT_PAT = re.compile(
    r"\b(?:books? about|about .{2,}|on the subject|topic of)\b",
    re.I,
)
_AUTHOR_PAT = re.compile(r"\b(?:by|written by|author)\b", re.I)
_TITLE_HINT_PAT = re.compile(
    r"\b(?:called|titled|named|title is|the book is)\b",
    re.I,
)

_MIN_TITLE_SEARCH_SCORE = 3
_MIN_CANDIDATE_SCORE = 4

_SINGLE_WORD_NON_TITLES = frozenset({
    "provide", "title", "author", "something", "payment", "order", "link", "bill",
    "please", "hello", "help", "coffee", "office", "recipe", "weather", "politics",
})

_HOW_TO_PAT = re.compile(
    r"\b("
    r"how (?:can|do) (?:i|you) (?:make|cook|brew|prepare)|"
    r"how to (?:make|cook|brew|prepare)|"
    r"can you tell me how|tell me (?:the )?recipe|"
    r"what(?:'s| is) the recipe"
    r")\b",
    re.I,
)
_OFF_DOMAIN_TOPIC_PAT = re.compile(
    r"\b("
    r"coffee|recipe|cooking|weather|politics|president|trump|"
    r"who is (?:donald )?trump|who won (?:the )?game|"
    r"what(?:'s| is) the weather|how(?:'s| is) the weather|"
    r"sports news|nba|nfl"
    r")\b",
    re.I,
)
_EXPLICIT_BOOK_CONTEXT_PAT = re.compile(
    r"\b("
    r"books? about|books? on|book called|book titled|do you have (?:a )?book|"
    r"search (?:for )?books?|find (?:a )?book|need (?:the )?book|"
    r"(?:called|titled|named)|isbn|title is|author is|written by"
    r")\b",
    re.I,
)
_MISTRANSCRIPTION_TITLE_PAT = re.compile(
    r"^(?:black|white|hot|cold)\s+(?:office|coffee|water|tea)$",
    re.I,
)


def is_general_how_to_query(query: str) -> bool:
    """True for cooking/recipe/how-to questions that must not trigger product search."""
    return bool(_HOW_TO_PAT.search((query or "").strip()))


def has_explicit_book_search_context(query: str) -> bool:
    """True when the caller explicitly asks about books in the catalog."""
    return bool(_EXPLICIT_BOOK_CONTEXT_PAT.search((query or "").strip()))


def is_off_domain_non_book_query(query: str) -> bool:
    """
    True for general factual/off-domain topics without explicit book-search context.

    Examples: 'who is Donald Trump', 'how can I make black coffee', 'black office'.
    """
    text = (query or "").strip()
    if not text:
        return False
    if is_general_how_to_query(text):
        return True
    if _MISTRANSCRIPTION_TITLE_PAT.match(text):
        return True
    if _OFF_DOMAIN_TOPIC_PAT.search(text) and not has_explicit_book_search_context(text):
        return True
    return False


def should_block_router_product_search(query: str, router_intent: str = "") -> bool:
    """Block router_hint product search for how-to and off-domain non-book queries."""
    if router_intent not in ("book_title_search", "product_search", "explicit_title_search", "author_search"):
        return False
    if is_off_domain_non_book_query(query):
        return True
    if is_general_how_to_query(query):
        return True
    if not has_explicit_book_search_context(query) and _MISTRANSCRIPTION_TITLE_PAT.match(
        _normalize_query(query)
    ):
        return True
    return False


def _normalize_query(query: str) -> str:
    q = (query or "").strip().lower()
    q = re.sub(r"[.!?]+$", "", q).strip()
    q = re.sub(r"\s+", " ", q)
    return q


def _meaningful_words(query: str) -> list[str]:
    stop = frozenset({
        "a", "an", "the", "i", "need", "want", "book", "books", "please",
        "can", "you", "provide", "give", "find", "help", "me", "do", "have",
        "is", "are", "my", "this", "that", "another", "any", "some",
    })
    return [w for w in re.split(r"\s+", query) if len(w) > 2 and w not in stop]


def score_product_query_specificity(query: str) -> QuerySpecificity:
    """Score how specific a product search query is."""
    raw = (query or "").strip()
    q = _normalize_query(raw)

    if not q:
        return QuerySpecificity(0, QuerySpecificityLevel.GENERIC, False, False, "empty")

    if is_off_domain_non_book_query(raw) or is_general_how_to_query(raw):
        return QuerySpecificity(0, QuerySpecificityLevel.GENERIC, False, False, "off_domain_or_how_to")

    if _MISTRANSCRIPTION_TITLE_PAT.match(q) and not has_explicit_book_search_context(raw):
        return QuerySpecificity(0, QuerySpecificityLevel.GENERIC, False, False, "mistranscription")

    digits = re.sub(r"\D", "", raw)
    if is_isbn(digits) or (len(digits) >= 10 and normalize_isbn(digits)):
        return QuerySpecificity(10, QuerySpecificityLevel.ISBN, True, True, "isbn")

    if re.match(r"^(?:a |the |my |this |that )?books?\s*[.!?]?\s*$", q):
        return QuerySpecificity(0, QuerySpecificityLevel.GENERIC, False, False, "book_only")

    if re.match(r"^(?:a |the )?books?\b", q):
        remainder = re.sub(r"^(?:a |the )?books?\s*[.!?]?\s*", "", q).strip()
        rem_words = _meaningful_words(remainder)
        if (
            not remainder
            or remainder in {"can you please provide", "please provide", "can you provide"}
            or not rem_words
            or all(w in _SINGLE_WORD_NON_TITLES for w in rem_words)
        ):
            return QuerySpecificity(0, QuerySpecificityLevel.GENERIC, False, False, "book_with_filler")

    if q in _GENERIC_EXACT or q in _NON_PRODUCT_PHRASES:
        return QuerySpecificity(0, QuerySpecificityLevel.GENERIC, False, False, "generic_exact")

    for pat in _GENERIC_PATTERNS:
        if pat.search(q):
            return QuerySpecificity(0, QuerySpecificityLevel.GENERIC, False, False, "generic_pattern")

    if _SUBJECT_PAT.search(q):
        words = _meaningful_words(q)
        score = max(3, len(words) + 2)
        return QuerySpecificity(
            score, QuerySpecificityLevel.SUBJECT, True, False, "subject_search",
        )

    if _AUTHOR_PAT.search(q):
        words = _meaningful_words(q)
        score = max(4, len(words) + 2)
        return QuerySpecificity(
            score, QuerySpecificityLevel.AUTHOR, True, score >= _MIN_CANDIDATE_SCORE, "author_search",
        )

    if _TITLE_HINT_PAT.search(q):
        words = _meaningful_words(q)
        score = max(5, len(words) + 3)
        return QuerySpecificity(
            score, QuerySpecificityLevel.EXPLICIT_TITLE, True, True, "explicit_title",
        )

    words = _meaningful_words(q)
    score = len(words)
    if len(q) >= 12:
        score += 1
    if re.search(r"\b(called|titled|named|about|author|isbn)\b", q):
        score += 2

    if len(words) == 1 and len(q) >= 5 and words[0] not in _SINGLE_WORD_NON_TITLES:
        return QuerySpecificity(
            4, QuerySpecificityLevel.EXPLICIT_TITLE, True, True, "single_word_title",
        )

    if len(words) >= 2 and q not in _GENERIC_EXACT:
        title_words = [w for w in re.split(r"\s+", raw.strip()) if w and w.lower() not in {
            "a", "an", "the", "book", "books", "called", "titled", "named",
        }]
        if len(title_words) >= 2:
            score = max(score, 4)
            return QuerySpecificity(
                score, QuerySpecificityLevel.EXPLICIT_TITLE, True, True, "named_title",
            )

    if score < _MIN_TITLE_SEARCH_SCORE:
        return QuerySpecificity(
            score, QuerySpecificityLevel.GENERIC, False, False, "low_specificity",
        )

    level = QuerySpecificityLevel.EXPLICIT_TITLE
    may_save = score >= _MIN_CANDIDATE_SCORE and len(words) >= 2
    return QuerySpecificity(score, level, True, may_save, "title_phrase")


def is_generic_product_query(query: str) -> bool:
    return score_product_query_specificity(query).level == QuerySpecificityLevel.GENERIC


def may_search_catalog(query: str) -> bool:
    return score_product_query_specificity(query).is_searchable


def may_auto_save_candidate(query: str, *, is_isbn: bool = False) -> bool:
    if is_isbn:
        return True
    return score_product_query_specificity(query).may_save_candidate
