"""LLM brain output contract validation and repair (v4.15.1)."""
from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

VALID_RESPONSE_MODES = frozenset({
    "direct_answer", "needs_tools", "clarify", "hold", "safe_refusal", "repair",
})

_CONVERSATION_INTENTS = frozenset({
    "identity", "small_talk", "company", "company_question", "company_purpose",
    "assistant_identity", "job_question", "memory_question", "presence_check",
    "capabilities", "frustration_repair", "acknowledgment",
})


def is_fake_checking_phrase(text: str) -> bool:
    """True if answer contains a fake checking phrase."""
    from .fake_checking_guard import is_fake_checking_phrase as _is_fake

    return _is_fake(text)


def repair_bad_direct_answer(
    answer: str,
    *,
    intent: str = "unknown",
    user_text: str = "",
    tool_started: bool = False,
    has_cart: bool = False,
) -> str:
    """Replace fake checking or empty direct answers with natural fallbacks."""
    from .fake_checking_guard import sanitize_fake_checking

    if not answer or is_fake_checking_phrase(answer):
        if tool_started:
            return answer
        repaired = sanitize_fake_checking(
            answer or "",
            tool_started=False,
            intent=intent,
            context={"has_cart": has_cart, "user_text": user_text},
        )
        if repaired != answer:
            logger.info(
                "llm_direct_answer_repaired intent=%s had_fake_check=%s",
                intent,
                is_fake_checking_phrase(answer or ""),
            )
        return repaired
    return answer


def validate_llm_decision(
    decision: dict,
    *,
    user_text: str = "",
    tool_started: bool = False,
    has_cart: bool = False,
    valid_tool_categories: Optional[frozenset] = None,
) -> dict:
    """Validate and repair LLM decision contract."""
    d = dict(decision or {})
    mode = str(d.get("response_mode") or "direct_answer").strip()
    if mode not in VALID_RESPONSE_MODES:
        mode = "direct_answer"
    d["response_mode"] = mode

    intent = str(d.get("intent") or "unknown").strip()
    d["intent"] = intent

    tool_categories = d.get("tool_categories") or []
    if not isinstance(tool_categories, list):
        tool_categories = []
    if valid_tool_categories:
        tool_categories = [t for t in tool_categories if t in valid_tool_categories]
    d["tool_categories"] = tool_categories

    direct_answer = str(d.get("direct_answer") or "").strip()

    if mode == "direct_answer":
        if tool_categories:
            logger.info("llm_contract_repair cleared_tools_for_direct_answer intent=%s", intent)
            d["tool_categories"] = []
        if direct_answer:
            d["direct_answer"] = repair_bad_direct_answer(
                direct_answer,
                intent=intent,
                user_text=user_text,
                tool_started=tool_started,
                has_cart=has_cart,
            )
        elif intent in _CONVERSATION_INTENTS:
            d["direct_answer"] = repair_bad_direct_answer(
                "",
                intent=intent,
                user_text=user_text,
                tool_started=tool_started,
                has_cart=has_cart,
            )

    if mode == "needs_tools" and not tool_categories:
        logger.info("llm_contract_repair needs_tools_without_categories intent=%s", intent)
        d["response_mode"] = "clarify"
        d["direct_answer"] = repair_bad_direct_answer(
            direct_answer,
            intent=intent or "unknown",
            user_text=user_text,
            tool_started=False,
            has_cart=has_cart,
        ) or _clarify_fallback(has_cart=has_cart)

    if d.get("response_mode") == "direct_answer" and d.get("direct_answer"):
        if is_fake_checking_phrase(d["direct_answer"]) and not tool_started:
            d["direct_answer"] = repair_bad_direct_answer(
                d["direct_answer"],
                intent=intent,
                user_text=user_text,
                tool_started=False,
                has_cart=has_cart,
            )

    return d


def _clarify_fallback(*, has_cart: bool = False) -> str:
    if has_cart:
        return (
            "I have your order in progress. Are you asking about the cart, price, or payment link?"
        )
    return (
        "I can help with books, newspapers, magazines, orders, or payment links. What would you like?"
    )
