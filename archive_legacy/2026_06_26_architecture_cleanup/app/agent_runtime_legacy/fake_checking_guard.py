"""Fake checking phrase guard (v4.15.1).

Never allow "Let me check on that" unless real tools are running.
"""
from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

_FAKE_CHECKING_MARKERS = (
    "let me check on that",
    "let me look that up",
    "checking that now",
    "one moment while i check",
    "i'll check that",
    "let me pull that up",
    "let me check that",
    "let me check",
)

_GREETING_PAT = re.compile(r"\b(how are you|how.?s it going|hello|hi there|good morning|good afternoon)\b", re.I)
_MEMORY_PAT = re.compile(
    r"\b(remember me|do you remember|spoke with you|talked to you|called before|"
    r"last year|previous call|you remember my)\b",
    re.I,
)
_CATALOG_VAGUE_PAT = re.compile(
    r"\b(give me|need|want|get me|can i have|can you give me)\b.*\b(newspaper|magazine|book)\b",
    re.I,
)
_PRESENCE_PAT = re.compile(r"\b(are you there|can you hear me|you still there)\b", re.I)


def is_fake_checking_phrase(text: str) -> bool:
    if not text:
        return False
    lowered = text.lower()
    return any(m in lowered for m in _FAKE_CHECKING_MARKERS)


def sanitize_fake_checking(
    answer: str,
    *,
    tool_started: bool,
    intent: str = "unknown",
    context: dict | None = None,
) -> str:
    """Remove fake checking phrases when no tool fanout has started."""
    ctx = context or {}
    text = (answer or "").strip()
    if not text or tool_started:
        return text
    if not is_fake_checking_phrase(text):
        return text

    user_text = str(ctx.get("user_text") or "")
    has_cart = bool(ctx.get("has_cart"))
    replacement = _replacement_for_context(intent, user_text, has_cart=has_cart)

    logger.info(
        "fake_checking_removed sid=%s intent=%s replacement=%s",
        str(ctx.get("sid", "?"))[:6],
        intent,
        replacement[:60],
    )
    return replacement


def _replacement_for_context(intent: str, user_text: str, *, has_cart: bool) -> str:
    t = user_text or ""

    if intent in ("small_talk", "greeting") or _GREETING_PAT.search(t):
        return "I'm doing well, thank you. How can I help you today?"

    if intent == "memory_question" or _MEMORY_PAT.search(t):
        if re.search(r"\blast year\b|\bfar back\b|\blong ago\b", t, re.I):
            return (
                "I may not have the details from a call that far back, but I can help you now."
            )
        return "I may not have the details from that call, but I'm here now. How can I help?"

    if intent == "presence_check" or _PRESENCE_PAT.search(t):
        return "Yes, I'm here. How can I help you today?"

    if intent in ("identity", "job_question", "capabilities", "company_question"):
        if intent == "job_question" or re.search(r"\bwhat is your job\b", t, re.I):
            return (
                "My job is to help you as the SureShot Books assistant. "
                "I can find books, check orders, help with shipping, payment links, refunds, and facility questions."
            )
        if re.search(r"\bwhat can you do\b", t, re.I):
            return (
                "I'm with SureShot Books. I can help with books, newspapers, magazines, "
                "orders, shipping, refunds, and payment links. What can I help you with?"
            )
        return "My name is Eric. I'm with SureShot Books."

    if intent in ("newspaper_request", "magazine_request", "vague_book_request", "book_search"):
        if _CATALOG_VAGUE_PAT.search(t) or re.search(r"\bnewspaper\b|\bmagazine\b", t, re.I):
            if re.search(r"\bnewspaper\b", t, re.I):
                return "Sure. Which newspaper are you looking for?"
            if re.search(r"\bmagazine\b", t, re.I):
                return "Sure. Which magazine are you looking for?"
            return "Sure. Which item are you looking for?"

    if has_cart:
        return (
            "I have your order in progress. Are you asking about your cart, price, or payment link?"
        )

    return (
        "I can help with books, newspapers, magazines, orders, or payment links. What would you like?"
    )
