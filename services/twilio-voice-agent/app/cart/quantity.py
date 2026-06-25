"""Shared quantity parsing for voice commerce (v4.30)."""
from __future__ import annotations

import re
from typing import Optional

# Production bulk orders — inmates/facilities often order 50–100+ copies.
MAX_LINE_QUANTITY = 500

_DIGIT_QTY = re.compile(
    r"\b(\d{1,4})\s*(?:cop(?:y|ies)|coffee|books?|pcs?|pieces?)?\b",
    re.I,
)

_WORD_QTY: dict[str, int] = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20,
    "twenty-five": 25, "twenty five": 25, "thirty": 30, "forty": 40,
    "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
    "hundred": 100, "a hundred": 100, "one hundred": 100,
}


def clamp_quantity(qty: int) -> int:
    return max(1, min(int(qty), MAX_LINE_QUANTITY))


def parse_spoken_quantity(text: str) -> Optional[int]:
    """Parse copy count from caller speech; None if not a quantity phrase."""
    t = (text or "").strip().lower()
    if not t:
        return None

    m = _DIGIT_QTY.search(t)
    if m:
        return clamp_quantity(int(m.group(1)))

    for phrase, val in sorted(_WORD_QTY.items(), key=lambda x: -len(x[0])):
        if re.search(rf"\b{re.escape(phrase)}\b", t):
            combo = re.search(
                rf"\b(\d+|{re.escape(phrase)})\s+hundred\b", t
            )
            if combo and phrase.isdigit() is False and "hundred" in t:
                lead = combo.group(1)
                if lead.isdigit():
                    return clamp_quantity(int(lead) * 100)
            return clamp_quantity(val)

    pairs = re.search(r"\b(\d+)\s+hundred\b", t)
    if pairs:
        return clamp_quantity(int(pairs.group(1)) * 100)

    return None
