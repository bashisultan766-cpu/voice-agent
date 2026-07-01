"""
Post-LLM output guardrails for the voice runtime.

Runs after the LLM produces a final spoken response and before it reaches
Twilio. These are deterministic safety checks (allowed by policy to remain
deterministic) layered on top of the existing ``sanitize_customer_response``:

* strip secrets / API tokens that must never be spoken,
* never speak a raw payment / checkout URL (callers receive links by email),
* never speak a full card number (keep only the last 4 digits),
* strip markdown / JSON artifacts so nothing machine-readable is spoken,
* enforce a voice-friendly length budget.

This module does not invent content; it only redacts and trims.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# Secret-like patterns that must never be spoken aloud.
_SECRET_PATTERNS: tuple[tuple[re.Pattern, str], ...] = (
    (re.compile(r"sk-[A-Za-z0-9_\-]{8,}"), "[redacted]"),
    (re.compile(r"shpat_[A-Za-z0-9]{8,}"), "[redacted]"),
    (re.compile(r"shpss_[A-Za-z0-9]{8,}"), "[redacted]"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._\-]{8,}", re.I), "[redacted]"),
    (re.compile(r"AC[0-9a-fA-F]{32}"), "[redacted]"),          # Twilio Account SID
    (re.compile(r"re_[A-Za-z0-9]{8,}"), "[redacted]"),          # Resend key
)

# Any URL — callers should be told the link was emailed, never read a URL.
_URL_PATTERN = re.compile(r"https?://\S+", re.I)

# A run of 13-19 digits (optionally separated) ~ a payment card number.
_CARD_PATTERN = re.compile(r"\b(?:\d[ -]?){13,19}\b")


def _luhn_valid(digits: str) -> bool:
    """Return True if digit string passes the Luhn checksum (payment cards)."""
    if not digits.isdigit() or len(digits) < 13:
        return False
    total = 0
    reverse = digits[::-1]
    for i, ch in enumerate(reverse):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def _is_isbn_digits(digits: str) -> bool:
    """True when digit run is a valid ISBN-10 or ISBN-13 (not a card)."""
    try:
        from ..tools.isbn import is_strict_valid_isbn

        return is_strict_valid_isbn(digits)
    except Exception:  # noqa: BLE001
        return len(digits) in (10, 13)


def _mask_cards(text: str, reasons: list[str]) -> str:
    def _mask(m: re.Match) -> str:
        digits = re.sub(r"\D", "", m.group(0))
        if len(digits) < 13:
            return m.group(0)
        if _is_isbn_digits(digits):
            return m.group(0)
        if not _luhn_valid(digits):
            return m.group(0)
        reasons.append("card_masked")
        return f"ending in {digits[-4:]}"

    return _CARD_PATTERN.sub(_mask, text)

_MARKDOWN_PATTERNS: tuple[re.Pattern, ...] = (
    re.compile(r"```.*?```", re.S),     # code fences
    re.compile(r"[*_`#>]+"),            # markdown markers
)

_DEFAULT_MAX_WORDS = 90  # hard cap; soft target is far lower per voice style
_VOICE_STYLE_MAX_SENTENCES = 2
_ROBOTIC_PATTERNS: tuple[re.Pattern, ...] = (
    re.compile(r"\bas an ai\b", re.I),
    re.compile(r"\bi am a language model\b", re.I),
    re.compile(r"\bsearch_products\b"),
    re.compile(r"\blookup_order_status\b"),
    re.compile(r"\{[^}]+\}"),  # JSON-ish
)


def apply_voice_style_guard(
    text: str,
    *,
    max_sentences: int = _VOICE_STYLE_MAX_SENTENCES,
    allow_long_order_disclosure: bool = False,
) -> str:
    """Trim to short natural phone speech — max sentences, no robotic phrasing."""
    if not text:
        return ""
    if allow_long_order_disclosure:
        max_sentences = max(max_sentences, 16)
    cleaned = text.strip()
    for pattern in _ROBOTIC_PATTERNS:
        cleaned = pattern.sub(" ", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    parts = re.split(r"(?<=[.!?])\s+", cleaned)
    parts = [p.strip() for p in parts if p.strip()]
    if len(parts) >= 2 and len(parts[0]) <= 8 and parts[0].endswith("!"):
        parts[0] = f"{parts[0]} {parts[1]}".strip()
        del parts[1]
    if len(parts) <= max_sentences:
        return cleaned
    if len(parts) > max_sentences:
        cleaned = " ".join(parts[:max_sentences])
        if not cleaned.endswith((".", "!", "?")):
            cleaned += "."
    return cleaned.strip()


@dataclass
class GuardResult:
    text: str
    modified: bool = False
    reasons: list[str] = field(default_factory=list)
    should_escalate: bool = False


def _redact_secrets(text: str, reasons: list[str]) -> str:
    for pattern, repl in _SECRET_PATTERNS:
        new = pattern.sub(repl, text)
        if new != text:
            reasons.append("secret_redacted")
            text = new
    return text


def _strip_urls(text: str, reasons: list[str]) -> str:
    if not _URL_PATTERN.search(text):
        return text
    reasons.append("url_blocked")
    # Replace each sentence that contains a URL — avoid false "I emailed you" claims.
    replacement = (
        "For security, I can't read payment links aloud. "
        "I can send it to your confirmed email."
    )
    parts = re.split(r"(?<=[.!?])\s+", text)
    kept: list[str] = []
    for part in parts:
        if _URL_PATTERN.search(part):
            if replacement not in kept:
                kept.append(replacement)
        else:
            kept.append(part)
    if not kept:
        return replacement
    return " ".join(kept).strip()



def _strip_markdown(text: str, reasons: list[str]) -> str:
    original = text
    for pattern in _MARKDOWN_PATTERNS:
        text = pattern.sub(" ", text)
    if text != original:
        reasons.append("markdown_stripped")
    return re.sub(r"\s{2,}", " ", text).strip()


def _enforce_length(text: str, max_words: int, reasons: list[str]) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text
    reasons.append("length_trimmed")
    trimmed = " ".join(words[:max_words]).rstrip(",.;:")
    if not trimmed.endswith((".", "!", "?")):
        trimmed += "."
    return trimmed


def apply_output_guardrails(
    text: str,
    *,
    max_words: int = _DEFAULT_MAX_WORDS,
    call_sid: str = "",
) -> GuardResult:
    """Apply all deterministic output guardrails. Never raises."""
    if not text:
        return GuardResult(text="", modified=False)

    from ..safety.response_sanitizer import is_order_disclosure_text

    order_disclosure = is_order_disclosure_text(text)
    original = text
    reasons: list[str] = []
    text = _redact_secrets(text, reasons)
    text = _strip_urls(text, reasons)
    text = _mask_cards(text, reasons)
    text = _strip_markdown(text, reasons)
    text = apply_voice_style_guard(
        text,
        allow_long_order_disclosure=order_disclosure,
    )
    if order_disclosure:
        disclosure_cap = max(max_words, 220)
        text = _enforce_length(text, disclosure_cap, reasons)
    else:
        text = _enforce_length(text, max_words, reasons)

    modified = text != original
    if modified:
        logger.info(
            "output_guardrails sid=%s modified=true reasons=%s",
            (call_sid or "")[:6], ",".join(sorted(set(reasons))) or "none",
        )
    return GuardResult(text=text, modified=modified, reasons=reasons)
