"""
Incremental entity extractor for partial transcripts.

Zero LLM calls — regex only. Designed to run on every STT partial (<5ms).

Entities detected:
    isbn         — ISBN-13, ISBN-10, or spoken digit sequences
    order_number — "#1234", "order 5678", "order number 5678"
    title_query  — "do you have X", "looking for X", "find X"
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

EntityType = Literal["isbn", "order_number", "title_query"]


@dataclass
class Entity:
    type: EntityType
    value: str
    confidence: float  # 0.0–1.0; lower = speculative (e.g. partial title)


# ── ISBN patterns ──────────────────────────────────────────────────────────────

_ISBN13 = re.compile(
    r'\b(?:978|979)[\s\-]?\d[\s\-]?\d{2}[\s\-]?\d{3}[\s\-]?\d{3}[\s\-]?\d\b'
)
_ISBN10 = re.compile(r'\b\d{9}[\dXx]\b')

# Spoken digits: "nine seven eight zero one two..." (10–13 words of single digits)
_SPOKEN_PREFIX = re.compile(r'\b(?:nine\s+seven\s+eight|nine\s+seven\s+nine)\b', re.I)
_DIGIT_WORD = re.compile(r'\b(zero|one|two|three|four|five|six|seven|eight|nine)\b', re.I)
_DIGIT_MAP = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
}

# ── Order number patterns ──────────────────────────────────────────────────────

_ORDER_NUM = re.compile(
    r'(?:order(?:\s+number)?|#)\s*(\d{4,8})',
    re.I,
)

# ── Title / product intent patterns ───────────────────────────────────────────

_TITLE_INTENT = re.compile(
    r'(?:do\s+you\s+have|looking\s+for|find\s+(?:me\s+)?|got|need|want|copy\s+of)'
    r'\s+(?:a\s+|the\s+|an\s+)?(.{4,80}?)(?=\s*[,?.!]|\s*$)',
    re.I,
)
_MIN_TITLE_CHARS = 5


def extract_entities(text: str) -> list[Entity]:
    """
    Extract actionable entities from a partial or final transcript.
    Returns entities sorted by confidence descending.
    Called on every STT partial — must be fast (regex only, no I/O).
    """
    entities: list[Entity] = []
    seen_isbns: set[str] = set()

    # ISBN-13 (numeric with optional separators)
    for m in _ISBN13.finditer(text):
        val = re.sub(r'[\s\-]', '', m.group())
        if val not in seen_isbns:
            seen_isbns.add(val)
            entities.append(Entity(type="isbn", value=val, confidence=0.95))

    # ISBN-10
    for m in _ISBN10.finditer(text):
        val = m.group()
        if val not in seen_isbns:
            seen_isbns.add(val)
            entities.append(Entity(type="isbn", value=val, confidence=0.90))

    # Spoken digits ("nine seven eight...")
    if _SPOKEN_PREFIX.search(text):
        spoken_isbn = _extract_spoken_digits(text)
        if spoken_isbn and spoken_isbn not in seen_isbns:
            seen_isbns.add(spoken_isbn)
            entities.append(Entity(type="isbn", value=spoken_isbn, confidence=0.70))

    # Order number
    for m in _ORDER_NUM.finditer(text):
        entities.append(Entity(
            type="order_number",
            value=m.group(1),
            confidence=0.90,
        ))

    # Title query
    m = _TITLE_INTENT.search(text)
    if m:
        title = m.group(1).strip().rstrip(".,!?")
        if len(title) >= _MIN_TITLE_CHARS:
            entities.append(Entity(
                type="title_query",
                value=title,
                confidence=0.65,
            ))

    return sorted(entities, key=lambda e: -e.confidence)


def _extract_spoken_digits(text: str) -> str:
    """
    Convert spoken digit words to a numeric string.
    Returns '' if fewer than 10 digits found (insufficient for ISBN).
    """
    digits = [_DIGIT_MAP[m.group(1).lower()] for m in _DIGIT_WORD.finditer(text)]
    return "".join(digits) if len(digits) >= 10 else ""
