"""Follow-up context resolver — commerce-aware utterance handling (v4.14.5)."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import TYPE_CHECKING, Optional

from .commerce_session import (
    CommerceSession,
    get_commerce_session,
    get_last_selected_or_best_candidate,
)
from .tool_entity_extractor import (
    is_add_to_cart_followup,
    is_availability_followup,
    is_generic_followup_phrase,
    is_price_followup,
    is_remove_from_cart_followup,
)

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_WHITESPACE = re.compile(r"\s+")


@dataclass
class FollowupContextResult:
    resolved: bool
    intent: str
    response_mode: str
    direct_answer: str | None
    tool_categories: list[str]
    expected_next: str | None
    source: str
    search_blocked: bool = False


def _norm(text: str) -> str:
    return _WHITESPACE.sub(" ", (text or "").strip())


def _fuzzy_title_match(phrase: str, title: str, threshold: float = 0.52) -> bool:
    p = _norm(phrase).lower()
    t = _norm(title).lower()
    if not p or not t:
        return False
    if p in t or t in p:
        return True
    p_words = set(re.findall(r"[a-z0-9]+", p))
    t_words = set(re.findall(r"[a-z0-9]+", t))
    if p_words and len(p_words & t_words) >= max(2, len(p_words) // 2):
        return True
    return SequenceMatcher(None, p, t).ratio() >= threshold


def _price_answer(candidate) -> str:
    if candidate.price:
        return (
            f"The price is {candidate.price}. "
            "Would you like me to add it to your order?"
        )
    return (
        f"I found {candidate.title}, but I don't have a confirmed price from the store right now."
    )


def _availability_answer(candidate) -> str:
    if candidate.availability == "out_of_stock":
        return "It looks out of stock right now."
    return "Yes, it looks available."


def _payment_link_phrase(text: str) -> bool:
    return bool(re.search(
        r"\b(send (?:me )?(?:the )?payment link|email me (?:the )?payment link|"
        r"send checkout|send the link|pay now)\b",
        text,
        re.I,
    ))


def _these_books_phrase(text: str) -> bool:
    return bool(re.search(r"\b(these books?|this book|that book)\b", text, re.I))


def _did_you_find_phrase(text: str) -> bool:
    return bool(re.search(r"\b(did you find it|did you find this|find it yet)\b", text, re.I))


def resolve_followup_context(
    text: str,
    *,
    sid: str,
    session_state: Optional["SessionState"] = None,
    commerce: CommerceSession | None = None,
) -> FollowupContextResult:
    """Resolve context-sensitive follow-ups before LLM or catalog search."""
    normalized = _norm(text)
    commerce = commerce or get_commerce_session(sid)
    candidate = get_last_selected_or_best_candidate(commerce)
    unresolved = FollowupContextResult(
        resolved=False,
        intent="unknown",
        response_mode="pass_through",
        direct_answer=None,
        tool_categories=[],
        expected_next=None,
        source="pass_through",
    )

    if not normalized:
        return unresolved

    if is_price_followup(normalized):
        if candidate:
            answer = _price_answer(candidate)
            logger.info("followup_context_resolved sid=%s intent=product_price_question source=commerce_context", sid[:6])
            return FollowupContextResult(
                resolved=True,
                intent="product_price_question",
                response_mode="direct_answer",
                direct_answer=answer,
                tool_categories=[],
                expected_next="add_to_cart_offer",
                source="commerce_context",
                search_blocked=True,
            )
        logger.info("followup_context_resolved sid=%s intent=product_price_question source=commerce_context", sid[:6])
        return FollowupContextResult(
            resolved=True,
            intent="product_price_question",
            response_mode="direct_answer",
            direct_answer="Which book are you asking about?",
            tool_categories=[],
            expected_next="book_identifier",
            source="commerce_context",
            search_blocked=True,
        )

    if is_availability_followup(normalized):
        if candidate:
            answer = _availability_answer(candidate)
            logger.info("followup_context_resolved sid=%s intent=product_availability_question source=commerce_context", sid[:6])
            return FollowupContextResult(
                resolved=True,
                intent="product_availability_question",
                response_mode="direct_answer",
                direct_answer=answer,
                tool_categories=[],
                expected_next="add_to_cart_offer",
                source="commerce_context",
                search_blocked=True,
            )
        return FollowupContextResult(
            resolved=True,
            intent="product_availability_question",
            response_mode="direct_answer",
            direct_answer="Which book are you asking about?",
            tool_categories=[],
            expected_next="book_identifier",
            source="commerce_context",
            search_blocked=True,
        )

    if is_add_to_cart_followup(normalized):
        if candidate and candidate.variant_id:
            from .cart_orchestrator import add_candidate_to_cart

            result = add_candidate_to_cart(commerce, candidate.candidate_id)
            if result.get("success"):
                logger.info("followup_context_resolved sid=%s intent=cart_mutation source=commerce_context", sid[:6])
                return FollowupContextResult(
                    resolved=True,
                    intent="cart_mutation",
                    response_mode="direct_answer",
                    direct_answer=result["message"],
                    tool_categories=[],
                    expected_next="another_book_or_payment",
                    source="commerce_context",
                )
        logger.info("followup_context_resolved sid=%s intent=cart_mutation source=commerce_context", sid[:6])
        return FollowupContextResult(
            resolved=True,
            intent="cart_mutation",
            response_mode="direct_answer",
            direct_answer="I need a confirmed book with a valid listing before I can add it.",
            tool_categories=[],
            expected_next="book_identifier",
            source="commerce_context",
        )

    if is_remove_from_cart_followup(normalized):
        from .cart_orchestrator import remove_cart_item

        result = remove_cart_item(commerce)
        logger.info("followup_context_resolved sid=%s intent=cart_mutation source=commerce_context", sid[:6])
        return FollowupContextResult(
            resolved=True,
            intent="cart_mutation",
            response_mode="direct_answer",
            direct_answer=result.get("message", "I removed that from your order."),
            tool_categories=[],
            expected_next=None,
            source="commerce_context",
        )

    if _these_books_phrase(normalized) and candidate:
        logger.info("followup_context_resolved sid=%s intent=add_offer source=commerce_context", sid[:6])
        return FollowupContextResult(
            resolved=True,
            intent="add_offer",
            response_mode="direct_answer",
            direct_answer=(
                f"I found {candidate.title}. Would you like me to add it to your order?"
            ),
            tool_categories=[],
            expected_next="add_to_cart_confirm",
            source="commerce_context",
            search_blocked=True,
        )

    if _did_you_find_phrase(normalized):
        answer = commerce.last_product_answer or commerce.last_tool_answer
        if answer:
            logger.info("followup_context_resolved sid=%s intent=pending_tool_status source=commerce_context", sid[:6])
            return FollowupContextResult(
                resolved=True,
                intent="pending_tool_status",
                response_mode="direct_answer",
                direct_answer=answer,
                tool_categories=[],
                expected_next=None,
                source="commerce_context",
            )

    if _payment_link_phrase(normalized):
        from .payment_link_orchestrator import handle_payment_request

        result = handle_payment_request(commerce, session_state=session_state)
        logger.info("followup_context_resolved sid=%s intent=payment_flow source=commerce_context", sid[:6])
        return FollowupContextResult(
            resolved=True,
            intent="payment_flow",
            response_mode=result.get("response_mode", "direct_answer"),
            direct_answer=result.get("message"),
            tool_categories=result.get("tool_categories", []),
            expected_next=result.get("expected_next"),
            source="commerce_context",
        )

    if is_generic_followup_phrase(normalized):
        logger.info("followup_context_resolved sid=%s intent=generic_followup source=commerce_context", sid[:6])
        return FollowupContextResult(
            resolved=True,
            intent="generic_followup",
            response_mode="pass_through",
            direct_answer=None,
            tool_categories=[],
            expected_next=None,
            source="commerce_context",
            search_blocked=True,
        )

    title_match = re.search(
        r"\bi need(?:\s+a)?\s+(?:the\s+)?(.{3,})",
        normalized,
        re.I,
    )
    if title_match and candidate:
        phrase = title_match.group(1).strip().rstrip(".!?")
        if _fuzzy_title_match(phrase, candidate.title) and not is_price_followup(phrase):
            logger.info("followup_context_resolved sid=%s intent=fuzzy_title_match source=commerce_context", sid[:6])
            return FollowupContextResult(
                resolved=True,
                intent="fuzzy_title_match",
                response_mode="direct_answer",
                direct_answer=(
                    f"Do you mean {candidate.title}? I found that one. "
                    "Would you like me to add it?"
                ),
                tool_categories=[],
                expected_next="add_to_cart_confirm",
                source="commerce_context",
                search_blocked=True,
            )

    return unresolved


def followup_result_to_decision(result: FollowupContextResult) -> dict:
    return {
        "response_mode": result.response_mode if result.response_mode != "pass_through" else "direct_answer",
        "intent": result.intent,
        "confidence": 0.93,
        "direct_answer": result.direct_answer or "",
        "tool_categories": list(result.tool_categories),
        "tool_reason": f"followup_{result.intent}",
        "one_question_to_ask": "",
        "domain_boundary": "in_domain",
        "safety_flags": [],
        "memory_instruction": "",
        "expected_next": result.expected_next or "",
        "search_query": "",
        "tool_entities": {},
        "followup_resolved": result.resolved,
        "search_blocked": result.search_blocked,
    }
