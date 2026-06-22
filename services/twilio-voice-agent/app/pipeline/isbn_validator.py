"""ISBN fragment accumulation and validation (v4.7)."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

_DIGIT_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
    "oh": "0",
}

_LAST_PART = re.compile(
    r"\b(?:last part is|the last part is|rest is|remaining is)\s+(.+)$",
    re.IGNORECASE,
)
_REPEAT = re.compile(r"\b(repeat again|say again|start over|try again)\b", re.IGNORECASE)


@dataclass
class ISBNValidationResult:
    action: str  # accumulating | complete | ask_remaining | ask_repeat | cleared
    isbn: str = ""
    buffer: str = ""
    message: str = ""


def extract_digits(text: str) -> str:
    t = text.strip().lower()
    for word, digit in _DIGIT_WORDS.items():
        t = re.sub(rf"\b{word}\b", digit, t)
    return re.sub(r"[^0-9xX]", "", t).upper()


def is_valid_isbn_checksum(digits: str) -> bool:
    d = digits.replace("-", "").replace(" ", "")
    if len(d) == 10:
        try:
            total = sum((10 - i) * (10 if c == "X" else int(c)) for i, c in enumerate(d))
            return total % 11 == 0
        except ValueError:
            return False
    if len(d) == 13:
        try:
            total = sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(d))
            return total % 10 == 0
        except ValueError:
            return False
    return False


def _sliding_window_isbn13(buf: str) -> Optional[str]:
    if len(buf) < 13:
        return None
    for start in range(len(buf) - 12):
        candidate = buf[start:start + 13]
        if is_valid_isbn_checksum(candidate):
            return candidate
    return None


def process_isbn_buffer(
    text: str,
    current_buffer: str,
    *,
    clear_on_repeat: bool = False,
) -> ISBNValidationResult:
    """
    Accumulate ISBN digit fragments; search only when 10/13 digits valid.
    """
    if _REPEAT.search(text):
        if clear_on_repeat:
            return ISBNValidationResult(
                action="cleared",
                buffer="",
                message="No problem. Please read the ISBN slowly from the start.",
            )
        return ISBNValidationResult(
            action="ask_repeat",
            buffer=current_buffer,
            message="Please repeat the full ISBN number slowly.",
        )

    last_m = _LAST_PART.search(text)
    if last_m:
        new_digits = extract_digits(last_m.group(1))
        buf = current_buffer + new_digits
    else:
        new_digits = extract_digits(text)
        buf = current_buffer + new_digits if new_digits else current_buffer

    if not buf and not new_digits:
        return ISBNValidationResult(
            action="accumulating",
            buffer=buf,
            message="Please read the ISBN digits slowly.",
        )

    if len(buf) > 14:
        found = _sliding_window_isbn13(buf)
        if found:
            return ISBNValidationResult(
                action="complete",
                isbn=found,
                buffer="",
                message=f"ISBN {found} captured.",
            )
        return ISBNValidationResult(
            action="ask_repeat",
            buffer="",
            message="I heard too many digits. Please repeat the full ISBN slowly.",
        )

    if len(buf) in (11, 12) or (buf.startswith(("978", "979")) and len(buf) in (10, 11, 12)):
        return ISBNValidationResult(
            action="ask_remaining",
            buffer=buf,
            message=f"I have {buf} so far. Please give me the remaining digits.",
        )

    if len(buf) >= 13:
        candidate = buf[:13]
        if is_valid_isbn_checksum(candidate):
            return ISBNValidationResult(
                action="complete",
                isbn=candidate,
                buffer="",
                message=f"ISBN {candidate} captured.",
            )
        found = _sliding_window_isbn13(buf)
        if found:
            return ISBNValidationResult(
                action="complete",
                isbn=found,
                buffer="",
                message=f"ISBN {found} captured.",
            )
        return ISBNValidationResult(
            action="ask_repeat",
            buffer=buf,
            message="Those digits don't form a valid ISBN. Please repeat the ISBN slowly.",
        )

    if len(buf) == 10:
        if buf.startswith(("978", "979")):
            return ISBNValidationResult(
                action="ask_remaining",
                buffer=buf,
                message=f"I have {buf} so far. Please continue with the remaining digits.",
            )
        if is_valid_isbn_checksum(buf):
            return ISBNValidationResult(
                action="complete",
                isbn=buf,
                buffer="",
                message=f"ISBN {buf} captured.",
            )
        return ISBNValidationResult(
            action="ask_repeat",
            buffer=buf,
            message="Those digits don't form a valid ISBN. Please repeat the ISBN slowly.",
        )

    if len(buf) >= 10 and buf.startswith(("978", "979")) and len(buf) < 13:
        return ISBNValidationResult(
            action="ask_remaining",
            buffer=buf,
            message=f"I have {buf} so far. Please continue with the remaining digits.",
        )

    # Do not search incomplete 979/978 prefixes with fewer than 10 digits
    if buf.startswith(("978", "979")) and len(buf) < 10:
        return ISBNValidationResult(
            action="accumulating",
            buffer=buf,
            message=f"I have {buf} so far. Please continue with the next digits.",
        )

    if len(buf) < 10:
        return ISBNValidationResult(
            action="accumulating",
            buffer=buf,
            message=f"I have {buf} so far. Please continue with the next digits.",
        )

    return ISBNValidationResult(
        action="accumulating",
        buffer=buf,
        message=f"I have {buf} so far. Please continue with the next digits.",
    )


def should_search_isbn(digits: str) -> bool:
    """True only when buffer is exactly 10 or 13 with valid checksum."""
    d = extract_digits(digits)
    if len(d) not in (10, 13):
        return False
    if d.startswith(("978", "979")) and len(d) == 10:
        return False
    return is_valid_isbn_checksum(d)
