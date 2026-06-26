"""Assistant response guarantee (v4.10).

Every complete turn must produce exactly one safe assistant response or intentional hold.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

_FALLBACK_TEXT = "I'm here. How can I help you with SureShot Books today?"

_VAGUE_BOOK_TEXT = (
    "Sure. Do you have the ISBN, title, author, or subject?"
)

_INTENT_FALLBACKS: dict[str, str] = {
    "unknown": _FALLBACK_TEXT,
    "identity_question": "My name is Eric. I'm with SureShot Books.",
    "agent_name_question": "My name is Eric. I'm with SureShot Books.",
    "job_question": (
        "I help SureShot Books customers with books, orders, shipping, refunds, "
        "facility questions, and payment links."
    ),
    "what_do_you_do": (
        "I help SureShot Books customers with books, orders, shipping, refunds, "
        "facility questions, and payment links."
    ),
    "company_question": (
        "I'm with SureShot Books. I can help with books, orders, shipping, "
        "refunds, and payment links."
    ),
    "company_origin_question": (
        "I'm with SureShot Books. I can help with books, orders, shipping, "
        "refunds, and payment links."
    ),
    "store_info_question": (
        "I'm with SureShot Books. I can help with books, orders, shipping, "
        "refunds, and payment links."
    ),
    "keepalive_question": "Yes, I'm here. Go ahead.",
    "small_talk": "I'm doing well, thank you. How can I help you today?",
    "vague_book_request": _VAGUE_BOOK_TEXT,
    "out_of_domain_question": (
        "I can help with SureShot Books. If you're looking for books about that topic, "
        "I can search our catalog."
    ),
}


@dataclass(frozen=True)
class ResponseGuardResult:
    text: str
    source: str  # original | plan | fallback | hold


def resolve_fallback_response(
    intent: str,
    *,
    response_plan: Optional[dict] = None,
    turn_holding: bool = False,
) -> Optional[ResponseGuardResult]:
    """Return fallback text when no response was produced. None if intentional hold."""
    if turn_holding:
        return None

    plan = response_plan or {}
    say = (plan.get("say") or "").strip()
    if say:
        return ResponseGuardResult(text=say, source="plan")

    fallback = _INTENT_FALLBACKS.get(intent, _FALLBACK_TEXT)
    return ResponseGuardResult(text=fallback, source="fallback")


def apply_response_guard(
    response_text: str,
    intent: str,
    *,
    call_sid: str = "",
    response_plan: Optional[dict] = None,
    turn_holding: bool = False,
) -> str:
    """
    Ensure non-empty response for complete turns.

    Logs response_guard_fallback when applying fallback.
    """
    if turn_holding:
        return response_text

    text = (response_text or "").strip()
    if text:
        return text

    result = resolve_fallback_response(
        intent,
        response_plan=response_plan,
        turn_holding=turn_holding,
    )
    if result is None:
        return ""

    sid = (call_sid or "")[:6]
    if result.source == "fallback":
        logger.info("response_guard_fallback sid=%s intent=%s", sid, intent)

    return result.text
