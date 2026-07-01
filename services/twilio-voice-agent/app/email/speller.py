"""Deterministic email speak/spell helpers for voice (v4.55)."""
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

_SPECIAL_CHAR_WORDS = {
    "-": "dash",
    "_": "underscore",
    "+": "plus",
    ".": "dot",
}

_COMMON_DOMAINS = {
    "gmail.com": "gmail dot com",
    "yahoo.com": "yahoo dot com",
    "hotmail.com": "hotmail dot com",
    "outlook.com": "outlook dot com",
    "icloud.com": "icloud dot com",
    "aol.com": "aol dot com",
    "protonmail.com": "protonmail dot com",
    "proton.me": "proton dot me",
    "live.com": "live dot com",
    "me.com": "me dot com",
    "msn.com": "msn dot com",
    "mail.com": "mail dot com",
    "zoho.com": "zoho dot com",
    "rediffmail.com": "rediffmail dot com",
    "gmx.com": "gmx dot com",
    "yandex.com": "yandex dot com",
    "att.net": "att dot net",
    "comcast.net": "comcast dot net",
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


def _char_to_voice_token(ch: str) -> str:
    """Map one stored email character to a TTS-friendly spoken token."""
    if ch.isalpha():
        return ch.upper()
    if ch.isdigit():
        return _DIGIT_WORDS[ch]
    return _SPECIAL_CHAR_WORDS.get(ch, ch)


def _spell_segment_chars(segment: str) -> str:
    """Period-separated tokens — ElevenLabs pauses clearly between each letter."""
    tokens = [_char_to_voice_token(ch) for ch in segment if ch]
    if not tokens:
        return ""
    return ". ".join(tokens) + "."


def _spell_hyphen_chunks(segment: str, *, group_size: int = 4) -> list[str]:
    """Hyphen-separated letter chunks for paced TTS (A-B-C-D)."""
    tokens = [_char_to_voice_token(ch) for ch in segment if ch]
    if not tokens:
        return []
    chunks: list[str] = []
    for i in range(0, len(tokens), group_size):
        group = tokens[i : i + group_size]
        chunks.append("-".join(group))
    return chunks


def _spell_micro_chunks(segment: str, *, group_size: int = 3) -> list[str]:
    """Split a segment into small TTS chunks so no letters are dropped on the phone."""
    tokens = [_char_to_voice_token(ch) for ch in segment if ch]
    if not tokens:
        return []
    chunks: list[str] = []
    for i in range(0, len(tokens), group_size):
        group = tokens[i : i + group_size]
        chunks.append(". ".join(group) + ".")
    return chunks


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
    Spell the entire stored email character-by-character for TTS readback.

    Uses comma-separated tokens and digit words so ElevenLabs reads exactly what
    is in the backend string — never hyphen chains that sound like other letters.

    Example: mubashirbusiness3@gmail.com →
    ``M, U, B, A, S, H, I, R, B, U, S, I, N, E, S, S, three, at, G, M, A, I, L, dot, C, O, M``
    """
    normalized = normalize_email_for_customer_readback(email)
    if not normalized or "@" not in normalized:
        return ""

    local, domain = normalized.split("@", 1)
    local_spelled = _spell_segment_chars(local)
    domain_parts = [part for part in domain.lower().split(".") if part]
    domain_spelled = ". Dot. ".join(_spell_segment_chars(part) for part in domain_parts)
    return f"{local_spelled}. At. {domain_spelled}"


def spell_email_for_voice(email: str) -> str:
    """Alias — full letter-by-letter readback from the stored email string."""
    return spell_email_letter_by_letter(email)


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


_EMAIL_READBACK_MARKER = re.compile(
    r"i have .+\.\s*i will spell it for confirmation|"
    r"letter\s+by\s+letter|just to confirm,\s+i heard|the name part",
    re.I,
)


def is_preserved_email_readback(text: str) -> bool:
    """True when text is a legacy full-line email spell-back (pre-chunked at runtime)."""
    return bool(_EMAIL_READBACK_MARKER.search(text or ""))


_EMAIL_SPELL_CHUNK_RE = re.compile(r"^[A-Z0-9](?:-[A-Z0-9])+\.?$")
_EMAIL_READBACK_LITERAL_PARTS = frozenset({
    "At",
    "Dot",
    "Is that correct?",
    "I will spell it for confirmation.",
})


def is_email_readback_tts_part(text: str) -> bool:
    """True for per-chunk email spell delivery at the final output stage."""
    part = (text or "").strip()
    if not part:
        return False
    if is_preserved_email_readback(part):
        return True
    if part in _EMAIL_READBACK_LITERAL_PARTS:
        return True
    if _EMAIL_SPELL_CHUNK_RE.match(part):
        return True
    lower = part.lower()
    if lower.startswith("i have ") and " at " in lower:
        return True
    return False


def _email_readback_fallback(email: str, raw_text: str = "") -> str:
    normalized = normalize_email_for_customer_readback(email)
    if not normalized:
        return "I do not have a complete email yet. Please spell it slowly."
    if email_confidence_is_low(normalized, raw_text):
        return "I may have heard that wrong. Please spell the email slowly."
    return ""


def build_email_readback(email: str, raw_text: str = "") -> str:
    """Pending email: heard once + hyphen spelling + confirmation."""
    return " ".join(build_email_readback_parts(email, raw_text))


def build_email_readback_parts(email: str, raw_text: str = "") -> list[str]:
    """Split readback into micro TTS chunks — each delivered with play_immediately."""
    normalized = normalize_email_for_customer_readback(email)
    fallback = _email_readback_fallback(email, raw_text)
    if fallback:
        return [fallback]

    spoken = speak_email(normalized)
    local, domain = normalized.split("@", 1)
    domain_parts = [part for part in domain.lower().split(".") if part]

    parts = [
        f"I have {spoken}.",
        "I will spell it for confirmation.",
    ]
    for chunk in _spell_hyphen_chunks(local):
        parts.append(chunk)
    parts.append("At")
    for idx, part in enumerate(domain_parts):
        for chunk in _spell_hyphen_chunks(part):
            parts.append(chunk)
        if idx < len(domain_parts) - 1:
            parts.append("Dot")
    parts.append("Is that correct?")
    return parts


def build_email_spell_only(email: str, raw_text: str = "") -> str:
    """Confirmed email: have + hyphen spelled readback."""
    normalized = normalize_email_for_customer_readback(email)
    if not normalized or email_confidence_is_low(normalized, raw_text):
        return "I do not have a complete email yet. Please spell it slowly."
    parts = build_email_readback_parts(email, raw_text)
    if parts and parts[-1] == "Is that correct?":
        parts = parts[:-1]
    return " ".join(parts)
