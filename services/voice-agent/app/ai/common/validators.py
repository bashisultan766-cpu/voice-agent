"""
Lightweight input normalizers shared across all v2 tools.

These are pure functions with no I/O — suitable for use inside
Pydantic validators and tool execute() methods.
"""
from __future__ import annotations

import re

# ── Compiled regexes ──────────────────────────────────────────────────────────

_DIGITS_RE = re.compile(r"\d+")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$", re.I)
_E164_RE = re.compile(r"^\+[1-9]\d{7,14}$")

_WORD_DIGITS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
}

# ── Order number ──────────────────────────────────────────────────────────────


def clean_order_number(raw: str) -> str:
    """
    Strip everything except digits.
    Handles voice input like 'order number  # 1 2 3 4' → '1234'.
    Handles word-digits like 'one two three four' → '1234'.
    """
    raw = raw.strip()
    # First try word-to-digit conversion (voice input)
    words = raw.lower().split()
    if all(w in _WORD_DIGITS for w in words) and len(words) >= 2:
        return "".join(_WORD_DIGITS[w] for w in words)
    # Fall back to extracting digit runs
    return "".join(_DIGITS_RE.findall(raw))


# ── Phone number ──────────────────────────────────────────────────────────────


def normalize_phone(raw: str) -> str:
    """
    Best-effort E.164 normalization.
    '+1 (555) 123-4567' → '+15551234567'
    '5551234567'        → '+15551234567'
    '+442071234567'     → '+442071234567'
    """
    digits = re.sub(r"\D", "", raw.strip())
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits[0] == "1":
        return f"+{digits}"
    if not digits:
        return raw.strip()
    return f"+{digits}"


def is_valid_e164(phone: str) -> bool:
    return bool(_E164_RE.match(phone))


# ── Email ─────────────────────────────────────────────────────────────────────


def is_valid_email(email: str) -> bool:
    return bool(_EMAIL_RE.match(email.strip()))


# ── General ───────────────────────────────────────────────────────────────────


def truncate(text: str, max_chars: int = 300) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "…"
