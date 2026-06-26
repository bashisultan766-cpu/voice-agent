"""Universal catalog taxonomy — books, newspapers, magazines, subscriptions (v4.14.7)."""
from __future__ import annotations

import re
from enum import Enum
from typing import Any

_WHITESPACE = re.compile(r"\s+")


class ProductKind(str, Enum):
    BOOK = "book"
    NEWSPAPER = "newspaper"
    MAGAZINE = "magazine"
    PUBLICATION = "publication"
    SUBSCRIPTION = "subscription"
    PRODUCT = "product"
    UNKNOWN = "unknown"


class PublicationTerm(str, Enum):
    TITLE = "title"
    ISBN = "isbn"
    SKU = "sku"
    HANDLE = "handle"
    PRODUCT_TYPE = "product_type"
    VENDOR = "vendor"
    FREQUENCY = "frequency"
    DURATION = "duration"
    EDITION = "edition"
    DELIVERY_DAYS = "delivery_days"


_NEWSPAPER_PAT = re.compile(
    r"\b(newspapers?|news\s+papers?|daily\s+paper|Sunday\s+paper)\b",
    re.I,
)
_MAGAZINE_PAT = re.compile(
    r"\b(magazines?|periodical?s?)\b",
    re.I,
)
_SUBSCRIPTION_PAT = re.compile(
    r"\b(subscription?s?|subscribe|subscribed)\b",
    re.I,
)
_BOOK_PAT = re.compile(
    r"\b(books?|novels?|isbn|author)\b",
    re.I,
)

# Generic "paper" only when paired with publication context or known titles
_PAPER_PUBLICATION_PAT = re.compile(
    r"\b("
    r"paper\s+available|(?:the\s+)?paper\b.*\b(?:delivery|subscription|available)|"
    r"(?:USA Today|Wall Street Journal|New York Times|NY Times|Washington Post|"
    r"Los Angeles Times|Chicago Tribune|Boston Globe|Financial Times)"
    r")\b",
    re.I,
)

_KNOWN_PUBLICATION_TITLES = (
    "USA Today",
    "Wall Street Journal",
    "New York Times",
    "NY Times",
    "Washington Post",
    "Los Angeles Times",
    "Chicago Tribune",
    "Boston Globe",
    "Financial Times",
    "People",
    "Time",
    "National Geographic",
    "Sports Illustrated",
    "Reader's Digest",
    "Cosmopolitan",
    "Vogue",
    "Forbes",
    "Fortune",
    "Newsweek",
    "The Economist",
)

_DELIVERY_FREQ_PATS = (
    (re.compile(r"\b(\d+)\s*day(?:s)?\s+delivery\b", re.I), "{n} day"),
    (re.compile(r"\b(daily|weekly|monthly|Sunday only|weekend only)\b", re.I), None),
    (re.compile(r"\b(7\s*day|5\s*day|3\s*day)\b", re.I), None),
)

_TERM_PATS = (
    re.compile(r"\b(\d+)\s+months?\b", re.I),
    re.compile(r"\b(one|two|three|four|five|six)\s+months?\b", re.I),
    re.compile(r"\b(one|1)\s+year\b", re.I),
    re.compile(r"\b(\d+)\s+years?\b", re.I),
    re.compile(r"\b6\s+months?\b", re.I),
    re.compile(r"\b3\s+months?\b", re.I),
)

_WEBSITE_CLAIM_PAT = re.compile(
    r"\b("
    r"(?:i\s+)?(?:can\s+)?see\s+(?:it|newspaper|magazine|book|product)\s+(?:on|in)\s+(?:your\s+)?(?:\w+[,\s]+){0,3}website|"
    r"(?:i\s+)?found\s+it\s+on\s+(?:your\s+)?(?:\w+[,\s]+){0,3}website|"
    r"(?:it(?:'s|\s+is)\s+)?on\s+(?:your\s+)?(?:\w+[,\s]+){0,3}website|"
    r"on\s+(?:the\s+)?(?:your\s+)?(?:\w+[,\s]+){0,3}website"
    r")\b",
    re.I,
)

_PRICE_MENTION_PAT = re.compile(
    r"\$\s*(\d+(?:\.\d{2})?)|\b(\d+(?:\.\d{2})?)\s+dollars?\b",
    re.I,
)

_VAGUE_NEWSPAPER_PAT = re.compile(
    r"\b("
    r"(?:can you|could you|do you)\s+(?:give me|get me|have|sell)\s+(?:a\s+)?newspapers?|"
    r"(?:i\s+)?need(?:\s+a)?\s+newspapers?|"
    r"looking for(?:\s+a)?\s+newspapers?|"
    r"do you have(?:\s+a)?\s+newspapers?|"
    r"newspapers?\s+available\??|"
    r"(?:a\s+)?newspapers?\s*,?\s*(?:can you|do you)\s+available"
    r")\b",
    re.I,
)

_VAGUE_MAGAZINE_PAT = re.compile(
    r"\b("
    r"(?:can you|could you|do you)\s+(?:give me|get me|have|sell)\s+(?:a\s+)?magazines?|"
    r"(?:i\s+)?need(?:\s+a)?\s+magazines?|"
    r"looking for(?:\s+a)?\s+magazines?|"
    r"do you have(?:\s+a)?\s+magazines?|"
    r"magazines?\s+available\??"
    r")\b",
    re.I,
)

_GENERIC_AVAIL_PAT = re.compile(
    r"^\s*(?:is\s+it\s+)?(?:in\s+stock|available\??|do you have it\??|availability\??)\s*[.!?]?\s*$",
    re.I,
)

_FILLER_PATS = (
    re.compile(r"\b(?:a|the|like|can you|could you|give me|i need|i want|do you have)\b", re.I),
    re.compile(r"\b(?:available|availability|paper available|in stock)\b", re.I),
    re.compile(r"\b(?:newspaper|magazine|subscription)\b", re.I),
)


def _norm(text: str) -> str:
    return _WHITESPACE.sub(" ", (text or "").strip())


def _extract_publication_title(text: str) -> str:
    normalized = _norm(text)
    for title in _KNOWN_PUBLICATION_TITLES:
        if re.search(re.escape(title), normalized, re.I):
            return title
    # Title before "magazine" e.g. "People magazine"
    m = re.search(
        r"\b([A-Z][A-Za-z0-9'&\-\s]{1,40}?)\s+magazines?\b",
        normalized,
    )
    if m:
        candidate = m.group(1).strip()
        if candidate.lower() not in {"a", "the", "this", "that", "do you have", "i need"}:
            return candidate
    # "newspaper, like X" or "like X"
    m = re.search(r"\blike\s+([A-Z][A-Za-z0-9'&\-\s]{2,40})", normalized)
    if m:
        title = m.group(1).strip()
        title = re.sub(r"\s+\d+\s+day.*", "", title, flags=re.I).strip()
        if len(title) >= 2:
            return title
    # Capitalized multi-word before delivery/subscription
    m = re.search(
        r"\b((?:USA Today|Wall Street Journal|New York Times|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+))"
        r"(?:\s+\d+\s+day|\s+delivery|\s+subscription|\s+paper|\s+available)",
        normalized,
    )
    if m:
        return m.group(1).strip()
    return ""


def detect_product_kind(text: str) -> ProductKind:
    normalized = _norm(text)
    if not normalized:
        return ProductKind.UNKNOWN
    if _NEWSPAPER_PAT.search(normalized) or _PAPER_PUBLICATION_PAT.search(normalized):
        return ProductKind.NEWSPAPER
    if _extract_publication_title(normalized):
        lower = normalized.lower()
        if "magazine" in lower:
            return ProductKind.MAGAZINE
        if "newspaper" in lower or " paper" in lower:
            return ProductKind.NEWSPAPER
        if _SUBSCRIPTION_PAT.search(normalized):
            return ProductKind.SUBSCRIPTION
        return ProductKind.PUBLICATION
    if _MAGAZINE_PAT.search(normalized):
        return ProductKind.MAGAZINE
    if _SUBSCRIPTION_PAT.search(normalized):
        return ProductKind.SUBSCRIPTION
    if _BOOK_PAT.search(normalized):
        return ProductKind.BOOK
    return ProductKind.UNKNOWN


def detect_publication_terms(text: str) -> dict[str, Any]:
    normalized = _norm(text)
    terms: dict[str, Any] = {}
    title = _extract_publication_title(normalized)
    if title:
        terms[PublicationTerm.TITLE.value] = title

    for pat, fmt in _DELIVERY_FREQ_PATS:
        m = pat.search(normalized)
        if m:
            if fmt and m.lastindex:
                terms[PublicationTerm.FREQUENCY.value] = fmt.format(n=m.group(1))
            else:
                terms[PublicationTerm.FREQUENCY.value] = m.group(0).strip()
            break

    for pat in _TERM_PATS:
        m = pat.search(normalized)
        if m:
            raw = m.group(0).strip()
            terms[PublicationTerm.DURATION.value] = raw
            months_match = re.search(r"(\d+)", raw)
            if months_match:
                terms["subscription_duration_months"] = int(months_match.group(1))
            elif "one year" in raw.lower() or "1 year" in raw.lower():
                terms["subscription_duration_months"] = 12
            break

    kind = detect_product_kind(normalized)
    if kind != ProductKind.UNKNOWN:
        terms["product_kind"] = kind.value

    price_m = _PRICE_MENTION_PAT.search(normalized)
    if price_m:
        terms["price_mentioned"] = price_m.group(1) or price_m.group(2)

    if _WEBSITE_CLAIM_PAT.search(normalized):
        terms["website_claim"] = True

    if kind == ProductKind.NEWSPAPER:
        terms["collection_hint"] = "newspapers"
        terms["product_type"] = "newspaper"
    elif kind == ProductKind.MAGAZINE:
        terms["collection_hint"] = "magazines"
        terms["product_type"] = "magazine"

    return terms


def is_newspaper_request(text: str) -> bool:
    normalized = _norm(text)
    if not normalized:
        return False
    if _NEWSPAPER_PAT.search(normalized):
        return True
    if _PAPER_PUBLICATION_PAT.search(normalized):
        return True
    kind = detect_product_kind(normalized)
    return kind == ProductKind.NEWSPAPER


def is_magazine_request(text: str) -> bool:
    return bool(_MAGAZINE_PAT.search(_norm(text))) or detect_product_kind(text) == ProductKind.MAGAZINE


def is_book_request(text: str) -> bool:
    return bool(_BOOK_PAT.search(_norm(text)))


def is_catalog_request(text: str) -> bool:
    normalized = _norm(text)
    if not normalized:
        return False
    kind = detect_product_kind(normalized)
    if kind not in (ProductKind.UNKNOWN, ProductKind.PRODUCT):
        return True
    if _WEBSITE_CLAIM_PAT.search(normalized):
        return True
    return False


def is_vague_newspaper_request(text: str) -> bool:
    normalized = _norm(text)
    if not is_newspaper_request(normalized):
        return False
    if _extract_publication_title(normalized):
        return False
    return bool(_VAGUE_NEWSPAPER_PAT.search(normalized) or _NEWSPAPER_PAT.search(normalized))


def is_vague_magazine_request(text: str) -> bool:
    normalized = _norm(text)
    if not is_magazine_request(normalized):
        return False
    if _extract_publication_title(normalized):
        return False
    return bool(_VAGUE_MAGAZINE_PAT.search(normalized) or _MAGAZINE_PAT.search(normalized))


def has_publication_title(text: str) -> bool:
    return bool(_extract_publication_title(text))


def is_website_catalog_claim(text: str) -> bool:
    return bool(_WEBSITE_CLAIM_PAT.search(_norm(text)))


def is_generic_availability_only(text: str) -> bool:
    """True when utterance is a short availability follow-up with no new product."""
    normalized = _norm(text)
    if has_publication_title(normalized) or is_catalog_request(normalized):
        return False
    if is_newspaper_request(normalized) or is_magazine_request(normalized):
        return False
    return bool(_GENERIC_AVAIL_PAT.match(normalized))


def build_product_phrase(text: str, terms: dict[str, Any] | None = None) -> str:
    """Clean product phrase without filler words."""
    terms = terms or detect_publication_terms(text)
    parts: list[str] = []
    title = terms.get(PublicationTerm.TITLE.value) or terms.get("title") or ""
    if title:
        parts.append(title)
    freq = terms.get(PublicationTerm.FREQUENCY.value) or terms.get("delivery_frequency") or ""
    if freq:
        parts.append(freq)
    duration = terms.get(PublicationTerm.DURATION.value) or terms.get("subscription_term") or ""
    if duration:
        parts.append(duration)
    if parts:
        return " ".join(parts)
    normalized = _norm(text)
    cleaned = normalized
    for pat in _FILLER_PATS:
        cleaned = pat.sub(" ", cleaned)
    cleaned = _WHITESPACE.sub(" ", cleaned).strip(" .,!?")
    return cleaned


def which_item_prompt(product_kind: ProductKind | str | None = None) -> str:
    kind = product_kind.value if isinstance(product_kind, ProductKind) else (product_kind or "")
    if kind == ProductKind.NEWSPAPER.value:
        return "Which newspaper are you asking about?"
    if kind == ProductKind.MAGAZINE.value:
        return "Which magazine are you asking about?"
    return "Which item are you asking about?"


_MIXED_SPLIT_PAT = re.compile(
    r"\s*,?\s*(?:\s+and\s+|\s*,\s*|\s+plus\s+|\s+also\s+)",
    re.I,
)


def extract_mixed_product_segments(text: str) -> list[str]:
    """Split mixed utterance into product segments."""
    normalized = _norm(text)
    if not normalized:
        return []
    if re.search(r"\band\s+another\s+book\b", normalized, re.I):
        return []
    if re.search(r"\bpen\s+and\s+link\b", normalized, re.I):
        return []
    # Remove leading "I need" / "I want"
    normalized = re.sub(
        r"^(?:i\s+(?:need|want|would like))\s+",
        "",
        normalized,
        flags=re.I,
    ).strip()
    if not _MIXED_SPLIT_PAT.search(normalized):
        return [normalized] if len(normalized) >= 3 else []
    parts = _MIXED_SPLIT_PAT.split(normalized)
    segments = [p.strip(" .,") for p in parts if p.strip(" .,") and len(p.strip()) >= 3]
    # Filter control/noise segments
    noise = {"this book", "that book", "a book", "the book"}
    return [s for s in segments if s.lower() not in noise]


def classify_product_segment(segment: str) -> dict[str, str]:
    """Classify a single segment as book/newspaper/magazine/generic."""
    kind = detect_product_kind(segment)
    terms = detect_publication_terms(segment)
    result: dict[str, str] = {"segment": segment}
    if kind != ProductKind.UNKNOWN:
        result["product_kind"] = kind.value
    isbn_match = re.sub(r"[\s-]", "", segment)
    isbn_digits = re.findall(r"\d{10,13}", isbn_match)
    if isbn_digits:
        for d in isbn_digits:
            if len(d) in (10, 13):
                result["isbn"] = d
                result["product_kind"] = ProductKind.BOOK.value
                break
    title = terms.get(PublicationTerm.TITLE.value) or terms.get("title") or ""
    if title:
        result["title"] = title
    elif kind == ProductKind.BOOK and not result.get("isbn"):
        # Strip "this book" prefix
        cleaned = re.sub(r"^(?:this|that|a|the)\s+book\s*", "", segment, flags=re.I).strip()
        if cleaned and len(cleaned) >= 3:
            result["title"] = cleaned
    if terms.get(PublicationTerm.FREQUENCY.value):
        result["delivery_frequency"] = str(terms[PublicationTerm.FREQUENCY.value])
    if terms.get(PublicationTerm.DURATION.value):
        result["subscription_term"] = str(terms[PublicationTerm.DURATION.value])
    phrase = build_product_phrase(segment, terms)
    if phrase:
        result["product_phrase"] = phrase
    return result

