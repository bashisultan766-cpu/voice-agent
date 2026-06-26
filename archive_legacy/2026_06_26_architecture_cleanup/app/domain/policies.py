"""SureShot domain policies — stay in scope, no invented data (v4.6)."""
from __future__ import annotations

import re

_OUT_OF_DOMAIN_DEBATE = re.compile(
    r"\b(debate|argue about|your opinion on|what do you think about)\s+"
    r"(politics|election|president|congress)\b",
    re.IGNORECASE,
)

_POLITICS_TOPIC = re.compile(
    r"\b(politics|political|election|government)\b",
    re.IGNORECASE,
)

_SPORTS_TOPIC = re.compile(
    r"\b(sports?|football|basketball|baseball|soccer|nfl|nba)\b",
    re.IGNORECASE,
)

_MEDICAL = re.compile(
    r"\b(diagnose|symptoms?|medicine|treatment|prescription|doctor said)\b",
    re.IGNORECASE,
)


def is_political_debate(text: str) -> bool:
    return bool(_OUT_OF_DOMAIN_DEBATE.search(text))


def is_politics_topic(text: str) -> bool:
    return bool(_POLITICS_TOPIC.search(text))


def is_sports_topic(text: str) -> bool:
    return bool(_SPORTS_TOPIC.search(text))


def is_medical_request(text: str) -> bool:
    return bool(_MEDICAL.search(text))


def politics_redirect_message() -> str:
    return "I can help you look for books on that topic."


def sports_redirect_message() -> str:
    return "I can help you look for books on that topic."


def medical_boundary_message() -> str:
    return (
        "I can't give medical advice. I can help with SureShot Books orders, "
        "books, shipping, and payment links."
    )
