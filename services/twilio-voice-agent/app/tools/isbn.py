"""
ISBN normalization for voice input.

Callers speak ISBNs in various formats:
  "nine seven eight zero one four three one two seven five five zero"
  "978-0-14-312755-0"
  "isbn 978 0143 127 550"
  "zero one four three one two seven five five x"  (ISBN-10 with X check digit)
  "0 14 312755 x"

normalize_isbn() returns a clean digit string (13 digits for ISBN-13,
10 chars for ISBN-10 where the last may be 'X'), or None if unrecognisable.
"""
from __future__ import annotations

import re

# Spoken digit words → digit character
_WORD_TO_DIGIT = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
    # Common mishearing/OCR variants
    "oh": "0", "o": "0", "nought": "0",
    "to": "2", "too": "2",
    "for": "4",
    "ate": "8",
    "sex": "6",
    "won": "1",
    "tree": "3",
    "fiver": "5",
    "niner": "9",
}

_STRIP_RE = re.compile(r"[-\s]")
_NONDIGIT_X = re.compile(r"[^0-9xX]")
_ISBN_PREFIX = re.compile(r"\bISBN[:\s-]*", re.IGNORECASE)


def _spoken_digits_to_string(text: str) -> str:
    """Convert spoken digit words to a digit string where possible."""
    words = text.lower().split()
    result: list[str] = []
    for w in words:
        clean = re.sub(r"[^a-z0-9x]", "", w)
        if clean in _WORD_TO_DIGIT:
            result.append(_WORD_TO_DIGIT[clean])
        elif re.fullmatch(r"[0-9x]+", clean):
            result.append(clean)
        # Ignore unrecognised words (they are probably not part of the ISBN)
    return "".join(result)


def normalize_isbn(text: str) -> str | None:
    """
    Attempt to extract and normalise an ISBN from arbitrary voice input.

    Returns:
        str — cleaned ISBN (10 or 13 chars, last char may be 'X' for ISBN-10).
        None — if the input cannot be identified as an ISBN.
    """
    if not text:
        return None

    # Strip "ISBN" keyword prefix.
    text = _ISBN_PREFIX.sub("", text).strip()

    # Try direct cleanup first (handles typed / pasted ISBNs with hyphens/spaces).
    direct = _NONDIGIT_X.sub("", text).upper()
    if _is_valid_isbn(direct):
        return direct

    # Try converting spoken words to digits.
    spoken = _spoken_digits_to_string(text).upper()
    if _is_valid_isbn(spoken):
        return spoken

    return None


def _is_valid_isbn(s: str) -> bool:
    """Return True for plausible ISBN-10 (10 chars) or ISBN-13 (13 digits)."""
    if not s:
        return False
    if len(s) == 13 and s.isdigit():
        return _isbn13_check(s)
    if len(s) == 10:
        body = s[:9]
        check = s[9]
        return body.isdigit() and (check.isdigit() or check == "X")
    return False


def _isbn13_check(isbn: str) -> bool:
    """Validate ISBN-13 check digit."""
    try:
        total = sum(
            int(d) * (1 if i % 2 == 0 else 3)
            for i, d in enumerate(isbn[:12])
        )
        check = (10 - (total % 10)) % 10
        return check == int(isbn[12])
    except ValueError:
        return False


def isbn10_to_isbn13(isbn10: str) -> str | None:
    """Convert a valid ISBN-10 to ISBN-13."""
    isbn10 = isbn10.upper().strip()
    if len(isbn10) != 10 or not isbn10[:9].isdigit():
        return None
    body = "978" + isbn10[:9]
    total = sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(body))
    check = (10 - (total % 10)) % 10
    return body + str(check)


def is_isbn(text: str) -> bool:
    """Quick check: does text look like it could contain an ISBN?"""
    # A sequence of 10 or more consecutive digits (possibly separated by spaces/hyphens)
    cleaned = _NONDIGIT_X.sub("", text.upper())
    return len(cleaned) in (10, 13)
