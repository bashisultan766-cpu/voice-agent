"""
BrandAliasNormalizer — STT corruption recovery for SureShot Books (v4.14.2).

Detects common speech-to-text mishearings of "SureShot Books" and normalizes
caller text before MainLLMAgent decision-making.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

LikelyIntent = Literal[
    "company_question",
    "assistant_identity",
    "company_purpose",
    "small_talk",
    "unknown",
]

CANONICAL_BRAND = "SureShot Books"
_BRAND_PLACEHOLDER = "\0SURESHOT_BRAND\0"

# Ordered longest-first so multi-word aliases match before shorter substrings.
_BRAND_ALIAS_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("show checkbook", re.compile(r"\bshow\s+checkbook\b", re.I)),
    ("brochure books", re.compile(r"\bbrochure\s+books\b", re.I)),
    ("brochure book", re.compile(r"\bbrochure\s+book\b", re.I)),
    ("shooter books", re.compile(r"\bshooter\s+books\b", re.I)),
    ("short books", re.compile(r"\bshort\s+books\b", re.I)),
    ("short book", re.compile(r"\bshort\s+book\b", re.I)),
    ("shard book", re.compile(r"\bshard\s+book\b", re.I)),
    ("short short", re.compile(r"\bshort\s+short\b", re.I)),
    ("show short", re.compile(r"\bshow\s+short\b", re.I)),
    ("shore shot", re.compile(r"\bshore\s+shot\b", re.I)),
    ("shor shot", re.compile(r"\bshor\s+shot\b", re.I)),
    ("sure shot", re.compile(r"\bsure\s+shot\b", re.I)),
    ("sure-shot", re.compile(r"\bsure-shot\b", re.I)),
    ("sureshort", re.compile(r"\bsureshort\b", re.I)),
    ("sure short", re.compile(r"\bsure\s+short\b", re.I)),
    ("shorkshire", re.compile(r"\bshorkshire\b", re.I)),
    ("sharkshire", re.compile(r"\bsharkshire\b", re.I)),
    ("sureshot", re.compile(r"\bsureshot\b", re.I)),
]

_CONTEXT_PAT = re.compile(
    r"\b("
    r"book|books|bookstore|assistant|company|sell|sells|selling|purpose|"
    r"who are you|what is|what are|what's|are you|your|work for|represent"
    r")\b",
    re.I,
)

_ASSISTANT_IDENTITY_PAT = re.compile(
    r"\b("
    r"are you|you are|you're|am i talking to|is this|assistant|"
    r"who sell|who sells|book assistant|books assistant"
    r")\b",
    re.I,
)

_COMPANY_QUESTION_PAT = re.compile(
    r"\b("
    r"what is|what are|what's|who is|who are|tell me about|"
    r"or you are|is this|what company|which company"
    r")\b",
    re.I,
)

_COMPANY_PURPOSE_PAT = re.compile(
    r"\b(purpose of|what is your purpose|what is the purpose|why do you exist)\b",
    re.I,
)

_SELL_QUESTION_PAT = re.compile(
    r"\b(what do you sell|what does .+ sell|do you sell books?)\b",
    re.I,
)


@dataclass
class BrandAliasResult:
    matched: bool = False
    canonical_text: str = ""
    canonical_brand: str = CANONICAL_BRAND
    aliases_found: list[str] = field(default_factory=list)
    confidence: float = 0.0
    likely_intent: LikelyIntent = "unknown"


def _classify_intent(text: str, has_alias: bool) -> LikelyIntent:
    lower = text.lower()
    if _SELL_QUESTION_PAT.search(text):
        return "company_question"
    if _COMPANY_PURPOSE_PAT.search(text):
        return "company_purpose"
    if "assistant" in lower and (has_alias or _ASSISTANT_IDENTITY_PAT.search(text)):
        return "assistant_identity"
    if re.search(r"\bare you\b", text, re.I) and has_alias:
        return "company_question"
    if re.search(r"\byou are\b", text, re.I) and has_alias:
        return "company_question"
    if _COMPANY_QUESTION_PAT.search(text) and has_alias:
        return "company_question"
    if has_alias and _CONTEXT_PAT.search(text):
        return "company_question"
    return "unknown"


def _cleanup_canonical_text(text: str) -> str:
    """Remove redundant book/brand fragments left after alias replacement."""
    cleaned = text
    cleaned = re.sub(
        rf"\byour\s+{re.escape(CANONICAL_BRAND)}\b",
        CANONICAL_BRAND,
        cleaned,
        flags=re.I,
    )
    cleaned = re.sub(
        rf"{re.escape(CANONICAL_BRAND)}\s+books\b",
        CANONICAL_BRAND,
        cleaned,
        flags=re.I,
    )
    cleaned = re.sub(
        rf"({re.escape(CANONICAL_BRAND)}\s+){{2,}}",
        f"{CANONICAL_BRAND} ",
        cleaned,
        flags=re.I,
    )
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def normalize_brand_aliases(text: str) -> BrandAliasResult:
    """Detect STT corruptions of SureShot Books and return normalized text."""
    original = (text or "").strip()
    if not original:
        return BrandAliasResult(canonical_text=original)

    lower = original.lower()
    aliases_found: list[str] = []
    canonical = original

    for alias_label, pattern in _BRAND_ALIAS_PATTERNS:
        if CANONICAL_BRAND.lower() in canonical.lower() and alias_label in (
            "sureshot", "sure shot", "sure-shot",
        ):
            continue
        if pattern.search(canonical):
            aliases_found.append(alias_label)
            canonical = pattern.sub(_BRAND_PLACEHOLDER, canonical)

    canonical = canonical.replace(_BRAND_PLACEHOLDER, CANONICAL_BRAND)
    canonical = _cleanup_canonical_text(canonical)

    has_explicit_brand = CANONICAL_BRAND.lower() in lower or CANONICAL_BRAND in canonical
    has_alias = bool(aliases_found)

    if not has_alias and not has_explicit_brand:
        return BrandAliasResult(
            matched=False,
            canonical_text=original,
            aliases_found=[],
            confidence=0.0,
            likely_intent="unknown",
        )

    has_context = bool(_CONTEXT_PAT.search(original))

    if has_alias and not has_context and not _COMPANY_QUESTION_PAT.search(original):
        if not _ASSISTANT_IDENTITY_PAT.search(original) and not _COMPANY_PURPOSE_PAT.search(original):
            return BrandAliasResult(
                matched=False,
                canonical_text=original,
                aliases_found=aliases_found,
                confidence=0.0,
                likely_intent="unknown",
            )

    likely_intent = _classify_intent(original, has_alias or has_explicit_brand)
    if likely_intent == "unknown" and (has_alias or has_explicit_brand) and has_context:
        likely_intent = "company_question"

    confidence = 0.85
    if has_alias and has_context:
        confidence = 0.92
    if likely_intent in ("assistant_identity", "company_question", "company_purpose"):
        confidence = max(confidence, 0.90)

    return BrandAliasResult(
        matched=True,
        canonical_text=canonical,
        canonical_brand=CANONICAL_BRAND,
        aliases_found=aliases_found,
        confidence=confidence,
        likely_intent=likely_intent,
    )
