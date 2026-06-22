"""Deterministic email spell/readback for voice (v4.6)."""
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


def normalize_email_for_customer_readback(email: str) -> str:
    """Lowercase normalized email for customer readback."""
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
  # split generic domains
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
    """
    Letter-by-letter spell-back for voice.

    Example: bashisultan766@gmail.com ->
    "b, a, s, h, i, s, u, l, t, a, n, seven, six, six, at gmail dot com"
    """
    normalized = normalize_email_for_customer_readback(email)
    if not normalized or "@" not in normalized:
        return ""

    local, domain = normalized.split("@", 1)
    local_parts = _local_voice_parts(local)
    domain_part = _domain_voice_part(domain)

    if domain.lower() == "gmail.com":
        spelled = ", ".join(local_parts)
        return f"{spelled}, at gmail dot com"

    spelled = ", ".join(local_parts)
    return f"{spelled}, at {domain_part}"


def email_confidence_is_low(email: str, raw_text: str = "") -> bool:
    """True when STT likely misheard @ as 'activate' or email fails validation."""
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
    return False


def build_email_readback(email: str, raw_text: str = "") -> str:
    """Full readback: heard email + letter-by-letter spelling."""
    normalized = normalize_email_for_customer_readback(email)
    if not normalized:
        return (
            "I may have heard that wrong. Please spell the email again slowly."
        )

    if email_confidence_is_low(normalized, raw_text):
        return (
            "I may have heard that wrong. Please spell the email again slowly."
        )

    spelled = spell_email_for_voice(normalized)
    return (
        f"I heard {normalized}. "
        f"Letter by letter, that is: {spelled}."
    )


def build_email_spell_only(email: str, raw_text: str = "") -> str:
    """Spell-back without confirmation question."""
    normalized = normalize_email_for_customer_readback(email)
    if not normalized or email_confidence_is_low(normalized, raw_text):
        return (
            "I may have heard that wrong. Please spell the email again slowly."
        )
    spelled = spell_email_for_voice(normalized)
    return f"Letter by letter, that is: {spelled}."
