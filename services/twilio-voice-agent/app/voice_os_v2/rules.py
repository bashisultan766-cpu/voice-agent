"""Deterministic planner rules — evaluated before any LLM call. No state mutation."""
from __future__ import annotations

import re
from typing import Optional

from ..tools.isbn import extract_isbn_candidate
from .session_state import V2SessionState
from .types import ConversationStage, Plan, PlanAction, ResponseMode

_GOODBYE = re.compile(
    r"\b(bye|goodbye|that'?s all|nothing else|hang up|end call|thank you bye)\b",
    re.I,
)
_GREETING = re.compile(r"^\s*(hi|hello|hey|good morning|good afternoon)\b", re.I)
_REPEAT = re.compile(
    r"^\s*(what\??|what did you say|repeat|say that again|pardon|come again)\s*[.!?]?\s*$",
    re.I,
)
_EMAIL_TYPED = re.compile(
    r"\b([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b",
    re.I,
)
_CART = re.compile(r"\b(cart|what(?:'s| is) in my cart)\b", re.I)
_SUPPORT = re.compile(r"\b(human|agent|customer service|speak to someone|complaint)\b", re.I)


def _normalize_email(text: str) -> str:
    from ..email.resolver import resolve_spoken_email_address

    resolved = resolve_spoken_email_address(text)
    if resolved:
        return resolved.strip().lower()
    m = _EMAIL_TYPED.search(text or "")
    return m.group(1).strip().lower() if m else ""


def evaluate_rules(state: V2SessionState, user_text: str) -> Optional[Plan]:
    text = (user_text or "").strip()
    if not text:
        return Plan(
            action=PlanAction.SPEAK,
            response_mode=ResponseMode.INSTANT,
            instant_text="I'm here. What can I help you with?",
            reason="empty_utterance",
        )

    if state.interrupt_flag and _REPEAT.match(text):
        return Plan(
            action=PlanAction.SPEAK,
            response_mode=ResponseMode.REPEAT_LAST,
            reason="interrupt_repeat",
        )

    if state.interrupt_flag:
        return Plan(
            action=PlanAction.SPEAK,
            response_mode=ResponseMode.INTERRUPT_ACK,
            instant_text="Go ahead — I'm listening.",
            reason="interrupt_continue",
        )

    if _GOODBYE.search(text):
        return Plan(
            action=PlanAction.END_CALL,
            response_mode=ResponseMode.INSTANT,
            instant_text="Thanks for calling SureShot Books. Have a great day!",
            stage_hint=ConversationStage.CLOSING.value,
            reason="goodbye",
        )

    if _CART.search(text) and state.cart:
        titles = ", ".join(
            f"{i.get('title', 'item')} x{i.get('quantity', 1)}"
            for i in state.cart[:5]
        )
        return Plan(
            action=PlanAction.SPEAK,
            response_mode=ResponseMode.INSTANT,
            instant_text=f"Your cart has {titles}.",
            reason="cart_inquiry",
        )

    isbn = extract_isbn_candidate(text)
    if isbn:
        return Plan(
            action=PlanAction.TOOL,
            tool="search_product_by_isbn",
            args={"isbn": isbn},
            response_mode=ResponseMode.TOOL_RESULT,
            reason="isbn_detected",
            stage_hint=ConversationStage.SHOPPING.value,
        )

    if _SUPPORT.search(text):
        return Plan(
            action=PlanAction.SPEAK,
            response_mode=ResponseMode.INSTANT,
            instant_text=(
                "I can forward your request to our support team. "
                "Please tell me your name and the best email to reach you."
            ),
            reason="support_handoff",
            stage_hint=ConversationStage.SUPPORT.value,
        )

    if _GREETING.match(text) and state.conversation_stage == ConversationStage.IDLE.value:
        return Plan(
            action=PlanAction.SPEAK,
            response_mode=ResponseMode.INSTANT,
            instant_text=(
                "Hi, this is SureShot Books. "
                "I can help you find a book, check an order, or send a payment link."
            ),
            reason="greeting",
        )

    if len(text.split()) >= 3 and state.conversation_stage in (
        ConversationStage.IDLE.value,
        ConversationStage.SHOPPING.value,
    ):
        return Plan(
            action=PlanAction.TOOL,
            tool="catalog_search",
            args={"query": text, "limit": 5},
            response_mode=ResponseMode.TOOL_RESULT,
            reason="title_search",
            stage_hint=ConversationStage.SHOPPING.value,
        )

    return None
