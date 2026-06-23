"""Tool eligibility gate — block tools for conversation-only turns (v4.15.1)."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

logger = logging.getLogger(__name__)

_CONVERSATION_ONLY_PATS = (
    re.compile(r"\bhow are you\b", re.I),
    re.compile(r"\bremember me\b", re.I),
    re.compile(r"\bdo you remember\b", re.I),
    re.compile(r"\bspoke with you\b", re.I),
    re.compile(r"\btalked to you\b", re.I),
    re.compile(r"\bcalled before\b", re.I),
    re.compile(r"\bi spoke with you\b", re.I),
    re.compile(r"\bare you there\b", re.I),
    re.compile(r"\bcan you hear me\b", re.I),
    re.compile(r"\bwho are you\b", re.I),
    re.compile(r"\bwhat is your job\b", re.I),
    re.compile(r"\bwhat can you do\b", re.I),
    re.compile(r"\bwhat do you do\b", re.I),
    re.compile(r"^(thanks|thank you|okay|ok|alright)[\s!.]*$", re.I),
)

_COMMERCE_SIGNAL_PATS = (
    re.compile(r"\bisbn\b", re.I),
    re.compile(r"\border number\b", re.I),
    re.compile(r"\brefund\b", re.I),
    re.compile(r"\bpayment link\b", re.I),
    re.compile(r"\bshipping\b", re.I),
    re.compile(r"\bfacility\b", re.I),
    re.compile(r"\binmate\b", re.I),
    re.compile(r"\busa today\b", re.I),
    re.compile(r"\b\d{3,}\b"),
    re.compile(
        r"\b(newspaper|magazine|subscription)\b.+\b(day|week|month|delivery|subscription)\b",
        re.I,
    ),
)

_CONVERSATION_INTENTS = frozenset({
    "identity", "small_talk", "company", "company_question", "company_purpose",
    "assistant_identity", "job_question", "memory_question", "presence_check",
    "capabilities", "frustration_repair", "acknowledgment", "off_domain",
})

_FRUSTRATION_ONLY_PAT = re.compile(
    r"^(damn|shit|fuck|hell|ugh|this is ridiculous|you suck|stupid)[\s!.]*$",
    re.I,
)


@dataclass
class ToolEligibilityResult:
    allowed: bool
    blocked: bool = False
    reason: str = ""
    direct_answer: str = ""
    use_direct_llm_answerer: bool = False
    intent: str = ""


def is_conversation_only_turn(user_text: str) -> bool:
    t = (user_text or "").strip()
    if not t:
        return True
    if _FRUSTRATION_ONLY_PAT.search(t):
        return True
    if any(p.search(t) for p in _CONVERSATION_ONLY_PATS):
        if not any(p.search(t) for p in _COMMERCE_SIGNAL_PATS):
            return True
    return False


def evaluate_tool_eligibility(
    user_text: str,
    llm_decision: dict,
    commerce_session=None,
) -> ToolEligibilityResult:
    """Allow tools only for explicit commerce intents with valid categories."""
    decision = dict(llm_decision or {})
    mode = decision.get("response_mode", "")
    intent = str(decision.get("intent") or "unknown")
    tool_categories = list(decision.get("tool_categories") or [])
    direct_answer = str(decision.get("direct_answer") or "").strip()

    logger.info(
        "tool_eligibility_checked intent=%s mode=%s categories=%s",
        intent,
        mode,
        tool_categories,
    )

    if mode != "needs_tools" or not tool_categories:
        return ToolEligibilityResult(
            allowed=False,
            blocked=False,
            reason="no_tools_requested",
            intent=intent,
        )

    if is_conversation_only_turn(user_text):
        logger.info("tool_eligibility_blocked reason=conversation_only intent=%s", intent)
        return _blocked_result(user_text, intent, direct_answer, commerce_session)

    if intent in _CONVERSATION_INTENTS:
        logger.info("tool_eligibility_blocked reason=conversation_intent intent=%s", intent)
        return _blocked_result(user_text, intent, direct_answer, commerce_session)

    if "payment_flow" in tool_categories and commerce_session is not None:
        cart_count = len(getattr(commerce_session, "cart_items", None) or [])
        candidates = getattr(commerce_session, "product_candidates", None) or []
        if cart_count == 0 and not candidates:
            logger.info("tool_eligibility_blocked reason=no_cart_for_payment")
            return ToolEligibilityResult(
                allowed=False,
                blocked=True,
                reason="no_cart_for_payment",
                direct_answer=(
                    direct_answer
                    or "Sure. What item would you like a payment link for?"
                ),
                intent="payment_clarify",
            )

    logger.info(
        "tool_eligibility_allowed reason=commerce_intent intent=%s categories=%s",
        intent,
        tool_categories,
    )
    return ToolEligibilityResult(allowed=True, blocked=False, reason="commerce_intent", intent=intent)


def _blocked_result(
    user_text: str,
    intent: str,
    direct_answer: str,
    commerce_session,
) -> ToolEligibilityResult:
    from .fake_checking_guard import sanitize_fake_checking

    has_cart = bool(commerce_session and getattr(commerce_session, "cart_items", None))
    if direct_answer:
        answer = sanitize_fake_checking(
            direct_answer,
            tool_started=False,
            intent=intent,
            context={"user_text": user_text, "has_cart": has_cart},
        )
        return ToolEligibilityResult(
            allowed=False,
            blocked=True,
            reason="conversation_only",
            direct_answer=answer,
            use_direct_llm_answerer=False,
            intent=intent,
        )

    return ToolEligibilityResult(
        allowed=False,
        blocked=True,
        reason="conversation_only",
        direct_answer="",
        use_direct_llm_answerer=True,
        intent=intent or "memory_question",
    )
