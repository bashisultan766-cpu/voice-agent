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
_SPOKEN_REPEAT = re.compile(
    r"\b(double|triple|quadruple)\s+"
    r"(zero|one|two|three|four|five|six|seven|eight|nine|oh|o|\d)\b",
    re.IGNORECASE,
)


def expand_spoken_repeaters(text: str) -> str:
    """Expand STT phrases like ``triple seven`` → ``7 7 7`` before ISBN parsing."""

    def _repl(match: re.Match) -> str:
        mult = {"double": 2, "triple": 3, "quadruple": 4}[match.group(1).lower()]
        token = match.group(2).lower()
        digit = _WORD_TO_DIGIT.get(token, token if token.isdigit() else "")
        if not digit:
            return match.group(0)
        return " ".join([digit] * mult)

    return _SPOKEN_REPEAT.sub(_repl, text or "")


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

    text = expand_spoken_repeaters(text)
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


# ── Strict checksum validation (additive — used by the deterministic ranker) ──
# `normalize_isbn` above is intentionally lenient (format-only for ISBN-10) for
# backward compatibility. The helpers below enforce full checksum validation so
# the runtime never treats a partial fragment (e.g. "9780") as a real ISBN and
# can rank an exact valid ISBN above title/fuzzy/fragment matches.

def isbn10_checksum_valid(s: str) -> bool:
    """Validate an ISBN-10 check digit (last char may be 'X')."""
    s = (s or "").upper().strip()
    if len(s) != 10 or not s[:9].isdigit():
        return False
    if not (s[9].isdigit() or s[9] == "X"):
        return False
    total = 0
    for i, c in enumerate(s):
        val = 10 if c == "X" else int(c)
        total += val * (10 - i)
    return total % 11 == 0


def isbn13_checksum_valid(s: str) -> bool:
    """Validate an ISBN-13 check digit."""
    s = (s or "").strip()
    if len(s) != 13 or not s.isdigit():
        return False
    return _isbn13_check(s)


def is_strict_valid_isbn(s: str) -> bool:
    """True only for a complete ISBN-10 or ISBN-13 with a correct checksum."""
    if not s:
        return False
    s = s.upper().strip()
    if len(s) == 13:
        return isbn13_checksum_valid(s)
    if len(s) == 10:
        return isbn10_checksum_valid(s)
    return False


def extract_isbn_candidate(text: str) -> str | None:
    """
    Extract a checksum-valid ISBN from spoken/typed text, or None.

    Unlike ``normalize_isbn`` this NEVER returns a partial fragment and never
    returns a structurally-valid-but-wrong-checksum string. Use this anywhere a
    value will be searched or saved as a final ISBN candidate.

    Returns a 13-digit ISBN-13 (ISBN-10 input is up-converted) or None.
    """
    candidate = normalize_isbn(text)
    if not candidate:
        return None
    if len(candidate) == 13 and isbn13_checksum_valid(candidate):
        return candidate
    if len(candidate) == 10 and isbn10_checksum_valid(candidate):
        upconverted = isbn10_to_isbn13(candidate)
        if upconverted and isbn13_checksum_valid(upconverted):
            return upconverted
    return None


def looks_like_isbn_fragment(text: str) -> bool:
    """
    True when text contains a digit run that resembles a partial ISBN
    (4-12 digits, or a 978/979 prefix) but is NOT a complete valid ISBN.

    Used to guard against searching/saving fragments like "9780".
    """
    cleaned = _NONDIGIT_X.sub("", (text or "").upper())
    if not cleaned or not cleaned[:1].isdigit():
        return False
    if is_strict_valid_isbn(cleaned):
        return False
    if cleaned.startswith(("978", "979")):
        return True
    return 4 <= len(cleaned) < 13
