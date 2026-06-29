"""Deterministic email speak/spell helpers for voice (v4.26)."""
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


def speak_email(email: str) -> str:
    """
    Speak a normalized email for voice — uses ``at`` and ``dot``, never raw ``@`` or ``.``.

    Example: bashisultan766@gmail.com → ``bashisultan766 at gmail dot com``
    """
    normalized = normalize_email_for_customer_readback(email)
    if not normalized or "@" not in normalized:
        return ""
    local, domain = normalized.split("@", 1)
    return f"{local} at {_domain_voice_part(domain)}"


def spell_email_letter_by_letter(email: str) -> str:
    """
    Spell the entire email letter-by-letter, including the domain.

    Example: jessica@sureshotbooks.com →
    ``J-E-S-S-I-C-A at S-U-R-E-S-H-O-T-B-O-O-K-S dot C-O-M``
    """
    normalized = normalize_email_for_customer_readback(email)
    if not normalized or "@" not in normalized:
        return ""

    local, domain = normalized.split("@", 1)

    def _spell_segment(segment: str) -> str:
        chars: list[str] = []
        for ch in segment:
            if ch.isalpha():
                chars.append(ch.upper())
            elif ch.isdigit():
                chars.append(ch)
            elif ch in "-_+.":
                chars.append(ch)
        return "-".join(chars)

    domain_parts = domain.lower().split(".")
    domain_spelled = " dot ".join(_spell_segment(part) for part in domain_parts if part)
    return f"{_spell_segment(local)} at {domain_spelled}"


def spell_email_for_voice(email: str) -> str:
    """
    Spell the local part letter-by-letter (uppercase) and digits one-by-one.

    Example: bashisultan766@gmail.com →
    ``B-A-S-H-I-S-U-L-T-A-N-7-6-6 at gmail dot com``
    """
    normalized = normalize_email_for_customer_readback(email)
    if not normalized or "@" not in normalized:
        return ""

    local, domain = normalized.split("@", 1)
    spelled_local: list[str] = []
    for ch in local:
        if ch.isalpha():
            spelled_local.append(ch.upper())
        elif ch.isdigit():
            spelled_local.append(ch)
        elif ch in "-_+.":
            spelled_local.append(ch)

    local_spelled = "-".join(spelled_local)
    domain_part = _domain_voice_part(domain)
    return f"{local_spelled} at {domain_part}"


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
    """Pending email: heard + spelled + confirmation."""
    normalized = normalize_email_for_customer_readback(email)
    if not normalized:
        return "I do not have a complete email yet. Please spell it slowly."

    if email_confidence_is_low(normalized, raw_text):
        return "I may have heard that wrong. Please spell the email slowly."

    spoken = speak_email(normalized)
    spelled = spell_email_letter_by_letter(normalized)
    return (
        f"I heard {spoken}. Letter by letter, that is {spelled}. Is that correct?"
    )


def build_email_spell_only(email: str, raw_text: str = "") -> str:
    """Confirmed email: have + spelled readback."""
    normalized = normalize_email_for_customer_readback(email)
    if not normalized or email_confidence_is_low(normalized, raw_text):
        return "I do not have a complete email yet. Please spell it slowly."
    spoken = speak_email(normalized)
    spelled = spell_email_for_voice(normalized)
    return f"I have {spoken}. That is {spelled}."
