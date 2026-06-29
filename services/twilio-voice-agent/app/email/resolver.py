"""
Unified spoken-email resolver for payment and support flows.

Tries every safe parser in priority order so thousands of unique ASR shapes
map to one verified address without involving the LLM.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Optional, TYPE_CHECKING

from .capture import (
    assemble_email_from_fragments,
    email_confidence,
    extract_best_email_phrase,
    is_domain_suffix_only,
    normalize_spoken_email,
    parse_hyphen_spelled_email,
)

if TYPE_CHECKING:
    from ..state.models import SessionState

_EMAIL_TYPED = re.compile(
    r"\b([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b",
    re.IGNORECASE,
)

_DOUBLE_LETTER = re.compile(r"\bdouble\s+([a-z0-9])\b", re.IGNORECASE)
_TRIPLE_LETTER = re.compile(r"\btriple\s+([a-z0-9])\b", re.IGNORECASE)


def _extract_typed_email(text: str) -> Optional[str]:
    match = _EMAIL_TYPED.search(text or "")
    if not match:
        return None
    return match.group(1).lower().strip()


@dataclass
class EmailResolveResult:
    email: str = ""
    confidence: str = "low"
    source: str = ""


def preprocess_letter_spelled_email(text: str) -> str:
    """Expand double/triple letter cues and clean commas before normalization."""
    t = (text or "").strip().lower()
    if not t:
        return ""
    t = _TRIPLE_LETTER.sub(lambda m: m.group(1) * 3, t)
    t = _DOUBLE_LETTER.sub(lambda m: m.group(1) * 2, t)
    return t


def parse_letter_spelled_email(text: str) -> Optional[str]:
    """
    Parse emails dictated letter-by-letter with optional double/triple cues.

    Example: "B I l a l a, double b, a s I 0 3 4 1 at gmail dot com"
    """
    prepped = preprocess_letter_spelled_email(text)
    if not prepped:
        return None
    if not re.search(r"\b(?:at|@|activate)\b", prepped, re.I):
        return None
    return normalize_spoken_email(prepped)


def resolve_spoken_email_address(
    text: str,
    session: Optional["SessionState"] = None,
) -> EmailResolveResult:
    """
    Resolve a spoken or typed email from caller text using every parser.

    Order: best phrase → typed → hyphen-spelled → letter-spelled → spoken
    → fragment assembly (when session has partial fragments).
    """
    raw = (text or "").strip()
    if not raw:
        return EmailResolveResult()

    phrases: list[str] = []
    best = extract_best_email_phrase(raw)
    if best:
        phrases.append(best)
    if raw not in phrases:
        phrases.append(raw)

    parsers: list[tuple[str, Callable[[str], Optional[str]]]] = [
        ("typed", _extract_typed_email),
        ("hyphen_spelled", parse_hyphen_spelled_email),
        ("letter_spelled", parse_letter_spelled_email),
        ("spoken", normalize_spoken_email),
    ]

    for phrase in phrases:
        for source, fn in parsers:
            try:
                email = fn(phrase)
            except Exception:  # noqa: BLE001
                email = None
            if email and "@" in email:
                conf = email_confidence(email, phrase)
                return EmailResolveResult(email=email, confidence=conf, source=source)

    if session is not None:
        fragments = list(getattr(session, "pending_email_fragments", None) or [])
        if raw:
            if is_domain_suffix_only(raw) and fragments:
                assembled = assemble_email_from_fragments(fragments + [raw])
                if assembled:
                    return EmailResolveResult(
                        email=assembled,
                        confidence=email_confidence(assembled, raw),
                        source="fragments",
                    )
            for combo in (fragments + [raw], fragments):
                if not combo:
                    continue
                assembled = assemble_email_from_fragments(combo)
                if assembled:
                    return EmailResolveResult(
                        email=assembled,
                        confidence=email_confidence(assembled, " ".join(combo)),
                        source="fragments",
                    )

    return EmailResolveResult()


def fragment_capture_prompt(fragment_count: int) -> str:
    """Escalating prompts so email capture never dead-ends on partial STT."""
    if fragment_count >= 5:
        return (
            "Let's try once more from the start. Please say your full email in one "
            "sentence — for example, john smith at gmail dot com."
        )
    if fragment_count >= 3:
        return (
            "I still need the complete address. Say the whole email from the "
            "beginning, including at and dot com."
        )
    if fragment_count >= 2:
        return (
            "I have part of it. Please say your full email address in one go, "
            "or continue with the remaining part."
        )
    return (
        "Got it — please continue with the rest of your email address, "
        "or say the full email again."
    )
