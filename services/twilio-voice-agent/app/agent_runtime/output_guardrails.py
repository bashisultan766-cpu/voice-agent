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

_MARKDOWN_PATTERNS: tuple[re.Pattern, ...] = (
    re.compile(r"```.*?```", re.S),     # code fences
    re.compile(r"[*_`#>]+"),            # markdown markers
)

_DEFAULT_MAX_WORDS = 90  # hard cap; soft target is far lower per voice style


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
    if _URL_PATTERN.search(text):
        text = _URL_PATTERN.sub("the secure link I emailed you", text)
        reasons.append("url_blocked")
    return text


def _mask_cards(text: str, reasons: list[str]) -> str:
    def _mask(m: re.Match) -> str:
        digits = re.sub(r"\D", "", m.group(0))
        if len(digits) < 13:
            return m.group(0)
        reasons.append("card_masked")
        return f"ending in {digits[-4:]}"

    return _CARD_PATTERN.sub(_mask, text)


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

    original = text
    reasons: list[str] = []
    text = _redact_secrets(text, reasons)
    text = _strip_urls(text, reasons)
    text = _mask_cards(text, reasons)
    text = _strip_markdown(text, reasons)
    text = _enforce_length(text, max_words, reasons)

    modified = text != original
    if modified:
        logger.info(
            "output_guardrails sid=%s modified=true reasons=%s",
            (call_sid or "")[:6], ",".join(sorted(set(reasons))) or "none",
        )
    return GuardResult(text=text, modified=modified, reasons=reasons)
