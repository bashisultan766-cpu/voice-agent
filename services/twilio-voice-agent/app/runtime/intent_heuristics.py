"""Deterministic intent heuristics for turn assembly (canonical fast paths)."""
from __future__ import annotations

import re

_ISBN = re.compile(r"\b(?:97[89]\d{10}|\d{9}[\dXx]|\d{13})\b")

_VAGUE_PRODUCT_UTTERANCES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^i need a book(?:\s+from you)?\.?$", re.I), "book"),
    (re.compile(r"^i want a book\.?$", re.I), "book"),
    (re.compile(r"^can i have a book\.?$", re.I), "book"),
    (re.compile(r"^i want to buy a book\.?$", re.I), "book"),
    (re.compile(r"^i need a magazine\.?$", re.I), "magazine"),
    (re.compile(r"^i need a newspaper\.?$", re.I), "newspaper"),
    (re.compile(r"^i want to place an order\.?$", re.I), "generic"),
    (re.compile(r"^(?:something to read|i need something to read)\.?$", re.I), "book"),
    (re.compile(r"^(?:a book|book|books|a magazine|magazine|a newspaper|newspaper)\.?$", re.I), "category"),
]

_VAGUE_CATEGORY_TAILS = frozenset({
    "book", "a book", "books", "magazine", "a magazine", "magazines",
    "newspaper", "a newspaper", "newspapers", "something to read",
})


def _normalize_smalltalk(text: str) -> str:
    cleaned = re.sub(r"[^\w\s]", " ", (text or "").lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def is_smalltalk(utterance: str) -> bool:
    """True for greetings and brief smalltalk that need no LLM."""
    norm = _normalize_smalltalk(utterance)
    if not norm:
        return False
    if re.fullmatch(r"(hi|hello|hey)( there| you)?", norm):
        return True
    if re.fullmatch(r"good (morning|afternoon|evening)( there)?", norm):
        return True
    if re.fullmatch(r"how are you( doing)?( today)?", norm):
        return True
    if re.search(r"\b(hi|hello|hey)\b", norm) and re.search(r"\bhow are you\b", norm):
        return len(norm.split()) <= 8
    return bool(re.match(r"^(hi|hello|hey|good\s+(morning|afternoon|evening))\b", utterance.strip(), re.I))


def _has_specific_product_detail(text: str) -> bool:
    if _ISBN.search(text):
        return True
    for pattern in (
        r"(?:looking for|search for|do you have|find)\s+(.+)",
        r"(?:i need|i want|can i have)\s+(.+)",
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
    """True when the caller named a category but not a searchable product."""
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
