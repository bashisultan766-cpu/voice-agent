"""Deterministic email spell/readback for voice (v4.7)."""
from __future__ import annotations

import re

_DIGIT_WORDS = {
    "0": "zero",
    "1": "one",
    "2": "two",
    "3": "three",
    "4": "four",
    "5": "five",
    "6": "six",
    "7": "seven",
    "8": "eight",
    "9": "nine",
}

_COMMON_DOMAINS = {
    "gmail.com": "gmail dot com",
    "yahoo.com": "yahoo dot com",
    "hotmail.com": "hotmail dot com",
    "outlook.com": "outlook dot com",
    "icloud.com": "icloud dot com",
}

_ACTIVATE_LOCAL_RE = re.compile(r"^activate@", re.IGNORECASE)
_EMAIL_RE = re.compile(
    r"^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$",
    re.IGNORECASE,
)
_NON_ASCII = re.compile(r"[^\x00-\x7F]+")


def normalize_email_for_customer_readback(email: str) -> str:
    if not email:
        return ""
    return email.strip().lower()


def mask_email(email: str) -> str:
    try:
        from ..caller.repository import mask_email as _mask
        return _mask(email)
    except Exception:
        if "@" in email:
            local, domain = email.split("@", 1)
            return f"{local[:1]}***@{domain}"
        return "***"


def _domain_voice_part(domain: str) -> str:
    lower = domain.lower()
    if lower in _COMMON_DOMAINS:
        return _COMMON_DOMAINS[lower]
    parts = lower.split(".")
    if len(parts) >= 2:
        return " dot ".join(parts)
    return lower


def _local_voice_parts(local: str) -> list[str]:
    parts: list[str] = []
    for ch in local.lower():
        if ch.isalpha():
            parts.append(ch)
        elif ch.isdigit():
            parts.append(_DIGIT_WORDS.get(ch, ch))
        elif ch in "-_":
            parts.append(ch)
    return parts


def spell_email_for_voice(email: str) -> str:
    normalized = normalize_email_for_customer_readback(email)
    if not normalized or "@" not in normalized:
        return ""

    local, domain = normalized.split("@", 1)
    local_parts = _local_voice_parts(local)

    if domain.lower() == "gmail.com":
        spelled = ", ".join(local_parts)
        return f"{spelled}, at gmail dot com"

    domain_part = _domain_voice_part(domain)
    spelled = ", ".join(local_parts)
    return f"{spelled}, at {domain_part}"


def email_confidence_is_low(email: str, raw_text: str = "") -> bool:
    normalized = normalize_email_for_customer_readback(email)
    if not normalized:
        return True
    if _ACTIVATE_LOCAL_RE.match(normalized):
        return True
    if raw_text and re.search(r"\bactivate\b", raw_text, re.IGNORECASE):
        if "@" not in raw_text:
            return True
    if not _EMAIL_RE.match(normalized):
        return True
    if _NON_ASCII.search(normalized):
        return True
    return False


def build_email_readback(email: str, raw_text: str = "") -> str:
    """Pending email: heard + letter-by-letter + confirmation."""
    normalized = normalize_email_for_customer_readback(email)
    if not normalized:
        return "I do not have a complete email yet. Please spell it slowly."

    if email_confidence_is_low(normalized, raw_text):
        return "I may have heard that wrong. Please spell the email slowly."

    spelled = spell_email_for_voice(normalized)
    return (
        f"I heard {normalized}. Letter by letter: {spelled}. Is that correct?"
    )


def build_email_spell_only(email: str, raw_text: str = "") -> str:
    """Confirmed email: have + letter-by-letter."""
    normalized = normalize_email_for_customer_readback(email)
    if not normalized or email_confidence_is_low(normalized, raw_text):
        return "I do not have a complete email yet. Please spell it slowly."
    spelled = spell_email_for_voice(normalized)
    return f"I have {normalized}. Letter by letter: {spelled}."
