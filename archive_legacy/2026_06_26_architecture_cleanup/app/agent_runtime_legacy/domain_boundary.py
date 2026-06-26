"""Domain boundary classification for SureShot Books (v4.16.0)."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

DomainStatus = Literal["in_domain", "domain_adjacent", "out_of_domain"]

_OUT_OF_DOMAIN_PAT = re.compile(
    r"\b("
    r"how (?:do|can) i (?:make|cook|prepare)|recipe|"
    r"who won|live score|match score|sports score|"
    r"weather|temperature|forecast|"
    r"tell me (?:the )?politics|political commentary|politics news|"
    r"latest news|world news|current events"
    r")\b",
    re.I,
)
_CATALOG_TOPIC_PAT = re.compile(
    r"\b("
    r"do you have (?:books?|magazines?|newspapers?)|"
    r"books? about|magazines? about|newspapers? about|"
    r"looking for (?:books?|magazines?|newspapers?)|"
    r"cooking magazines?|cricket books?|cricket magazines?|"
    # Subscription / delivery patterns — direct product intent
    r"(?:i (?:need|want)|(?:can i|do you) (?:get|order|buy))\s+(?:[a-z][a-z\s]{0,30}\s+)?(?:newspaper|magazine|book|subscription)|"
    r"(?:delivery|subscription)\s+(?:for\s+)?\d+\s+(?:month|week|year|day)|"
    r"(?:\d+\s+(?:month|week|year|day))\s+(?:delivery|subscription)"
    r")\b",
    re.I,
)
_TOPIC_EXTRACT_PAT = re.compile(
    r"\b(?:about|on|for)\s+([a-z][a-z\s]{2,30}?)(?:\?|$|\.)",
    re.I,
)


@dataclass(frozen=True)
class DomainClassification:
    status: DomainStatus
    topic: str = ""
    redirect_answer: str | None = None
    catalog_search: bool = False


def classify_domain(user_text: str) -> DomainClassification:
    text = re.sub(r"\s+", " ", (user_text or "").strip())
    if not text:
        return DomainClassification(status="in_domain")

    if _CATALOG_TOPIC_PAT.search(text):
        return DomainClassification(status="in_domain", catalog_search=True)

    if _OUT_OF_DOMAIN_PAT.search(text):
        topic = _extract_topic(text)
        return DomainClassification(
            status="out_of_domain",
            topic=topic,
            redirect_answer=_redirect_for(text, topic),
        )

    if re.search(r"\b(cook(?:ing)?|cricket|politics|tea|sports|health|religion)\b", text, re.I):
        if re.search(r"\b(book|magazine|newspaper|catalog|subscription|order)\b", text, re.I):
            return DomainClassification(status="domain_adjacent", catalog_search=True)
        if re.search(r"\b(how to|how do i|who won|tell me|news)\b", text, re.I):
            topic = _extract_topic(text)
            return DomainClassification(
                status="out_of_domain",
                topic=topic,
                redirect_answer=_redirect_for(text, topic),
            )

    return DomainClassification(status="in_domain")


def _extract_topic(text: str) -> str:
    match = _TOPIC_EXTRACT_PAT.search(text)
    if match:
        return match.group(1).strip()
    for keyword in ("tea", "cricket", "cooking", "politics", "sports"):
        if re.search(rf"\b{keyword}\b", text, re.I):
            return keyword
    return "that topic"


def _redirect_for(text: str, topic: str) -> str:
    lowered = text.lower()
    if re.search(r"\b(how (?:do|can) i|recipe|make tea|cook)\b", lowered):
        return (
            "I can't walk you through a recipe, but I can help find cookbooks "
            "or magazines about tea and cooking if you'd like."
        )
    if re.search(r"\b(who won|cricket|match|score|sports)\b", lowered):
        return (
            "I don't have live sports scores, but I can help look for cricket books, "
            "magazines, or newspapers in the store."
        )
    if re.search(r"\b(politics|political|news)\b", lowered):
        return (
            "I can't provide general political commentary, but I can help find "
            "newspapers, magazines, or books on that topic."
        )
    return (
        f"I mainly help with SureShot Books. If you want books or magazines about "
        f"{topic}, I can search our catalog."
    )
