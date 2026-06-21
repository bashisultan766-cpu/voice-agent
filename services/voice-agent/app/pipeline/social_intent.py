"""Greeting/social detection and tool-intent classification for voice turns."""
from __future__ import annotations

import re

from .intent import extract_entities

_SOCIAL_GREETING = re.compile(
    r"^\s*(hi|hello|hey|yo|good\s+(?:morning|afternoon|evening))[\s!.,?]*$",
    re.I,
)
_SOCIAL_PHRASES = (
    re.compile(r"\bhow\s+are\s+you\b", re.I),
    re.compile(r"\bhow\s+is\s+it\s+going\b", re.I),
    re.compile(r"\bwhat'?s\s+up\b", re.I),
    re.compile(r"\bwhat\s+are\s+you\s+doing\b", re.I),
    re.compile(r"\bnice\s+to\s+(?:meet|talk)\b", re.I),
)

_TOOL_INTENT = (
    re.compile(r"\b(?:order|tracking|track\s+my|where\s+is\s+my)\b", re.I),
    re.compile(r"\b(?:search|find|look(?:ing)?\s+for|do\s+you\s+have|got\s+any)\b", re.I),
    re.compile(r"\b(?:inventory|in\s+stock|available|catalog|isbn)\b", re.I),
    re.compile(r"\b(?:book|books|product|products)\b", re.I),
)

_SOCIAL_RESPONSE = (
    "Hi, I'm doing well. How can I help you with your order or a book today?"
)


def is_social_utterance(text: str) -> bool:
    """True for greetings/smalltalk without actionable commerce entities."""
    cleaned = text.strip()
    if not cleaned:
        return False
    if extract_entities(cleaned):
        return False
    if _SOCIAL_GREETING.match(cleaned):
        return True
    if any(p.search(cleaned) for p in _SOCIAL_PHRASES):
        return True
    # Short social-only utterances (e.g. "hello how are you")
    lowered = cleaned.lower()
    social_tokens = (
        "hello",
        "hi",
        "hey",
        "how",
        "are",
        "you",
        "doing",
        "well",
        "good",
        "morning",
        "afternoon",
        "evening",
        "thanks",
        "thank",
    )
    words = re.findall(r"[a-z']+", lowered)
    if words and all(w in social_tokens for w in words) and len(words) <= 8:
        return True
    return False


def should_play_filler(text: str, pre_fetched: dict | None = None) -> bool:
    """Filler only when a tool lookup is actually starting."""
    if is_social_utterance(text):
        return False
    if pre_fetched:
        return True
    if extract_entities(text):
        return True
    return any(p.search(text) for p in _TOOL_INTENT)


def social_response_text() -> str:
    return _SOCIAL_RESPONSE
