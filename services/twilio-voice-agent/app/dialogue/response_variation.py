"""Safe response variation for small talk (v4.10).

Deterministic templates with rotation — never vary business-critical wording.
"""
from __future__ import annotations

import re
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

_MAX_SMALL_TALK_WORDS = 25
_MAX_REPEAT = 2

# Intents where exact wording must never change
_FROZEN_INTENTS = frozenset({
    "payment_execute", "send_payment_link", "email_provided", "email_confirmation",
    "spell_email_request", "ending_thanks",
})

_OUT_OF_DOMAIN_VARIANTS = (
    "I can help with SureShot Books. If you're looking for books about that topic, "
    "I can search our catalog.",
    "I can't provide general information on that, but I can help search SureShot Books "
    "for related books.",
    "My role is to help with SureShot Books orders and books. "
    "Would you like me to search our catalog?",
)

_SMALL_TALK_VARIANTS: dict[str, tuple[str, ...]] = {
    "small_talk": (
        "I'm doing well, thank you. How can I help you today?",
        "I'm good, thanks for asking. What can I help you with?",
        "Doing well, thank you. How can I help with SureShot Books today?",
    ),
    "identity_question": (
        "My name is Eric. I'm with SureShot Books.",
        "I'm Eric, with SureShot Books.",
        "Eric here — I'm with SureShot Books.",
    ),
    "agent_name_question": (
        "My name is Eric. I'm with SureShot Books.",
        "I'm Eric, with SureShot Books.",
    ),
    "keepalive_question": (
        "Yes, I'm here. Go ahead.",
        "I'm here. What do you need?",
        "Yes, still here. Go ahead.",
    ),
    "job_question": (
        "I help SureShot Books customers with books, orders, shipping, refunds, "
        "facility questions, and payment links.",
    ),
    "what_do_you_do": (
        "I help SureShot Books customers with books, orders, shipping, refunds, "
        "facility questions, and payment links.",
    ),
    "company_question": (
        "I'm with SureShot Books. I can help with books, orders, shipping, "
        "refunds, and payment links.",
    ),
    "company_origin_question": (
        "I'm with SureShot Books. I can help with books, orders, shipping, "
        "refunds, and payment links.",
    ),
    "store_info_question": (
        "I'm with SureShot Books. I can help with books, orders, shipping, "
        "refunds, and payment links.",
    ),
    "frustration_repair": (
        "I understand. Let me slow down and fix this.",
        "I'm sorry about the trouble. Let me help step by step.",
    ),
    "out_of_domain_question": _OUT_OF_DOMAIN_VARIANTS,
    "vague_book_request": (
        "Sure. Do you have the ISBN, title, author, or subject?",
        "I can help find a book. Do you have the ISBN, title, author, or subject?",
    ),
}

_BUSINESS_CRITICAL_PATTERNS = (
    re.compile(r"processing fee", re.I),
    re.compile(r"payment link", re.I),
    re.compile(r"subtotal before shipping", re.I),
    re.compile(r"red river vengeance", re.I),
    re.compile(r"not in stock", re.I),
)


def _truncate_words(text: str, max_words: int) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words]).rstrip(".,;") + "."


def _get_usage(session: Optional["SessionState"]) -> dict[str, int]:
    if session is None:
        return {}
    raw = getattr(session, "response_variation_counts", None)
    if isinstance(raw, dict):
        return raw
    return {}


def _record_usage(session: Optional["SessionState"], key: str, text: str) -> None:
    if session is None:
        return
    counts = _get_usage(session)
    counts[key] = counts.get(key, 0) + 1
    session.response_variation_counts = counts
    recent: list = getattr(session, "recent_small_talk_lines", None) or []
    recent.append(text)
    session.recent_small_talk_lines = recent[-20:]


def _pick_variant(
    intent: str,
    variants: tuple[str, ...],
    session: Optional["SessionState"],
) -> str:
    if not variants:
        return ""
    if len(variants) == 1:
        return variants[0]

    recent: list = getattr(session, "recent_small_talk_lines", None) or []
    for candidate in variants:
        count = sum(1 for line in recent if line == candidate)
        if count < _MAX_REPEAT:
            return candidate
    # All over limit — rotate by usage
    usage = _get_usage(session)
    idx = usage.get(intent, 0) % len(variants)
    return variants[idx]


def get_varied_response(
    intent: str,
    default: str,
    session: Optional["SessionState"] = None,
) -> str:
    """
    Return varied small-talk text unless business-critical or frozen intent.
    """
    if intent in _FROZEN_INTENTS:
        return default

    for pat in _BUSINESS_CRITICAL_PATTERNS:
        if pat.search(default):
            return default

    variants = _SMALL_TALK_VARIANTS.get(intent)
    if not variants:
        return _truncate_words(default, _MAX_SMALL_TALK_WORDS)

    text = _pick_variant(intent, variants, session)
    text = _truncate_words(text, _MAX_SMALL_TALK_WORDS)
    _record_usage(session, intent, text)
    return text


def get_out_of_domain_variant(session: Optional["SessionState"] = None) -> str:
    return get_varied_response(
        "out_of_domain_question",
        _OUT_OF_DOMAIN_VARIANTS[0],
        session,
    )
