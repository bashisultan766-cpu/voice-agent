"""Deterministic intent heuristics — fast pre-classification without LLM."""
from __future__ import annotations

import re
from typing import TYPE_CHECKING

from .types import SupervisorResult

if TYPE_CHECKING:
    from ..state.models import SessionState

_ISBN = re.compile(r"\b(?:97[89]\d{10}|\d{9}[\dXx]|\d{13})\b")
_ORDER_NUM = re.compile(r"\b(?:order\s*)?#?\s*(\d{4,8})\b", re.I)
_PAYMENT = re.compile(
    r"\b(payment\s*link|pay\s*now|checkout|send\s+(?:me\s+)?(?:the\s+)?link|charge\s+my\s+card)\b",
    re.I,
)
_REFUND = re.compile(r"\b(refund|money\s+back|returned\s+payment)\b", re.I)
_FACILITY = re.compile(r"\b(facility|prison|jail|inmate|correctional)\b", re.I)
_DELIVERY_ISSUE = re.compile(
    r"\b(not delivered|wasn't delivered|not received|returned|sent back|rejected)\b",
    re.I,
)
_PERIODICAL = re.compile(r"\b(magazine|newspaper|periodical)\b", re.I)
_SHIPPING = re.compile(r"\b(shipping|delivery|tracking|media\s+mail|address\s+change)\b", re.I)
_ESCALATE = re.compile(r"\b(speak\s+to\s+(?:a\s+)?(?:human|person|agent|manager)|customer\s+service)\b", re.I)
_CART = re.compile(r"\b(add\s+to\s+cart|remove\s+from\s+cart|my\s+cart|update\s+quantity)\b", re.I)
_EMAIL = re.compile(r"\b(email|e-mail|inbox|@|gmail|yahoo|hotmail)\b", re.I)
_PRODUCT = re.compile(
    r"\b(book|isbn|title|author|search|looking\s+for|do\s+you\s+have|compare)\b",
    re.I,
)
_INCOMPLETE = re.compile(
    r"^(?:can i have|i want|can you find|i'?m looking for|im looking for|looking for|do you have)\s*[,.]?\s*$",
    re.I,
)
_YES = re.compile(
    r"^(?:yes|yeah|yep|yup|correct|that'?s right|that is right|affirmative|sure|ok(?:ay)?)\s*[.!]?\s*$",
    re.I,
)
_NO = re.compile(r"^(?:no|nope|nah|not really)\s*[.!]?\s*$", re.I)

# Intents that must never invoke the supervisor LLM.
FAST_PATH_INTENTS = frozenset({
    "smalltalk",
    "identity_email_collection",
    "checkout_payment",
    "product_search",
    "order_status",
    "refund_status",
    "facility_question",
    "cart_update",
    "escalation",
})

_INCOMPLETE_CLARIFICATION = "Sure — what title or ISBN are you looking for?"

_INTENT_CATEGORIES: dict[str, list[str]] = {
    "product_search": ["catalog", "read"],
    "cart_update": ["cart", "write"],
    "checkout_payment": ["payment", "write"],
    "order_status": ["order", "read"],
    "refund_status": ["order", "read"],
    "facility_question": ["facility", "read"],
    "shipping_question": ["policy", "read"],
    "faq": ["policy", "read"],
    "identity_email_collection": ["identity"],
    "escalation": ["escalate"],
    "smalltalk": [],
    "unknown": [],
}


def _normalize_smalltalk(text: str) -> str:
    cleaned = re.sub(r"[^\w\s]", " ", (text or "").lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def is_smalltalk(utterance: str) -> bool:
    """True for greetings and brief smalltalk that need no LLM."""
    norm = _normalize_smalltalk(utterance)
    if not norm:
        return False
    if re.fullmatch(r"(hi|hello|hey)( there| you)?", norm):
        return True
    if re.fullmatch(r"good (morning|afternoon|evening)( there)?", norm):
        return True
    if re.fullmatch(r"how are you( doing)?( today)?", norm):
        return True
    if re.search(r"\b(hi|hello|hey)\b", norm) and re.search(r"\bhow are you\b", norm):
        return len(norm.split()) <= 8
    return bool(re.match(r"^(hi|hello|hey|good\s+(morning|afternoon|evening))\b", utterance.strip(), re.I))


def is_incomplete_utterance(utterance: str) -> bool:
    """True when the caller clearly started a request but did not finish."""
    text = (utterance or "").strip()
    if not text:
        return False
    if _INCOMPLETE.match(text):
        return True
    # Short trailing fragments without a noun/title (e.g. "Can I have")
    words = re.sub(r"[^\w\s]", "", text.lower()).split()
    if len(words) <= 3 and any(
        text.lower().startswith(p)
        for p in ("can i have", "i want", "can you find", "i'm looking for", "im looking for")
    ):
        return not _ISBN.search(text) and not _ORDER_NUM.search(text)
    return False


def resolve_smalltalk_response(utterance: str) -> str:
    """Deterministic spoken reply for greeting/smalltalk — no LLM."""
    norm = _normalize_smalltalk(utterance)
    has_greeting = bool(re.search(r"\b(hi|hello|hey|good (morning|afternoon|evening))\b", norm))
    has_how_are_you = bool(re.search(r"\bhow are you\b", norm))

    if has_greeting and has_how_are_you:
        return "I'm doing well, thank you. What can I help you find today?"
    if has_how_are_you:
        return "I'm doing well, thank you. What book or order can I help you with?"
    return "Hi, this is SureShot Books. How can I help you today?"


def resolve_yes_no_response(utterance: str) -> str:
    if _YES.match((utterance or "").strip()):
        return "Got it. What else can I help you with?"
    return "No problem. What can I help you with instead?"


def is_fast_path_supervisor_result(result: SupervisorResult) -> bool:
    """True when the heuristic result should bypass the supervisor LLM entirely."""
    if result.intent == "smalltalk":
        return True
    if result.clarifying_question and result.reason in (
        "incomplete_utterance",
        "empty_utterance",
        "yes_no_reply",
        "low_confidence",
        "order_detail_unverified",
        "refund_unverified",
    ):
        return True
    if result.intent in FAST_PATH_INTENTS and result.confidence >= 0.92:
        return True
    if result.intent == "shipping_question" and result.confidence >= 0.84:
        return True
    return False


def classify_intent_heuristic(
    text: str,
    session: "SessionState | None" = None,
    *,
    turn_mode: str = "",
) -> SupervisorResult:
    """Return a supervisor-shaped result using deterministic rules."""
    utterance = (text or "").strip()
    lower = utterance.lower()

    if not utterance:
        return SupervisorResult(
            intent="unknown",
            confidence=0.2,
            clarifying_question="I didn't catch that. Could you repeat that for me?",
            reason="empty_utterance",
        )

    if is_incomplete_utterance(utterance):
        return SupervisorResult(
            intent="unknown",
            confidence=0.95,
            needs_tools=False,
            risk_level="low",
            clarifying_question=_INCOMPLETE_CLARIFICATION,
            reason="incomplete_utterance",
        )

    if is_smalltalk(utterance):
        return SupervisorResult(
            intent="smalltalk",
            confidence=0.96,
            needs_tools=False,
            risk_level="low",
            reason="greeting",
        )

    if _YES.match(utterance) or _NO.match(utterance):
        return SupervisorResult(
            intent="smalltalk",
            confidence=0.96,
            needs_tools=False,
            risk_level="low",
            clarifying_question=resolve_yes_no_response(utterance),
            reason="yes_no_reply",
        )

    if (turn_mode or "").lower() == "email" or _EMAIL.search(utterance):
        if session and getattr(session, "awaiting_payment_email_confirmation", False):
            return SupervisorResult(
                intent="identity_email_collection",
                confidence=0.95,
                needs_tools=False,
                risk_level="medium",
                allowed_tool_categories=_INTENT_CATEGORIES["identity_email_collection"],
                reason="email_confirmation_turn",
            )
        return SupervisorResult(
            intent="identity_email_collection",
            confidence=0.95,
            needs_tools=False,
            risk_level="medium",
            allowed_tool_categories=_INTENT_CATEGORIES["identity_email_collection"],
            reason="email_capture",
        )

    if _ESCALATE.search(utterance):
        return SupervisorResult(
            intent="escalation",
            confidence=0.92,
            needs_tools=True,
            needs_planner=True,
            risk_level="low",
            allowed_tool_categories=_INTENT_CATEGORIES["escalation"],
            reason="escalation_phrase",
        )

    if _PAYMENT.search(utterance) or (
        session and getattr(session, "payment_flow_status", "") in (
            "awaiting_send_confirmation", "awaiting_email_confirmation",
        )
    ):
        return SupervisorResult(
            intent="checkout_payment",
            confidence=0.95,
            needs_tools=True,
            needs_planner=True,
            risk_level="high",
            allowed_tool_categories=_INTENT_CATEGORIES["checkout_payment"],
            reason="payment_intent",
        )

    if _ISBN.search(utterance):
        return SupervisorResult(
            intent="product_search",
            confidence=0.96,
            needs_tools=True,
            needs_planner=True,
            risk_level="low",
            allowed_tool_categories=_INTENT_CATEGORIES["product_search"],
            reason="isbn_query",
        )

    if _PRODUCT.search(utterance) and not _ORDER_NUM.search(utterance):
        # Obvious title/search phrasing — skip supervisor LLM.
        title_hint = re.search(
            r"(?:looking for|search for|do you have|find)\s+(.+)",
            utterance,
            re.I,
        )
        conf = 0.94 if title_hint and len(title_hint.group(1).strip().split()) >= 2 else 0.82
        return SupervisorResult(
            intent="product_search",
            confidence=conf,
            needs_tools=True,
            needs_planner=True,
            risk_level="low",
            allowed_tool_categories=_INTENT_CATEGORIES["product_search"],
            reason="product_query",
        )

    if _REFUND.search(utterance):
        verified = _has_order_verification(utterance, session)
        if not verified:
            return SupervisorResult(
                intent="refund_status",
                confidence=0.88,
                needs_tools=False,
                risk_level="high",
                clarifying_question=(
                    "I can look up refund details after I verify your order. "
                    "What email or phone number is on the order?"
                ),
                allowed_tool_categories=_INTENT_CATEGORIES["refund_status"],
                reason="refund_unverified",
            )
        return SupervisorResult(
            intent="refund_status",
            confidence=0.94,
            needs_tools=True,
            needs_planner=True,
            risk_level="medium",
            allowed_tool_categories=_INTENT_CATEGORIES["refund_status"],
            reason="refund_verified",
        )

    if _ORDER_NUM.search(utterance) or "order status" in lower or "where is my order" in lower:
        verified = _has_order_verification(utterance, session)
        if not verified and _asks_sensitive_order_detail(lower):
            return SupervisorResult(
                intent="order_status",
                confidence=0.9,
                needs_tools=False,
                risk_level="high",
                clarifying_question=(
                    "For security, I'll need the email or phone number on the order "
                    "before I can share those details."
                ),
                allowed_tool_categories=_INTENT_CATEGORIES["order_status"],
                reason="order_detail_unverified",
            )
        return SupervisorResult(
            intent="order_status",
            confidence=0.94 if _ORDER_NUM.search(utterance) else 0.85,
            needs_tools=True,
            needs_planner=True,
            risk_level="medium" if not verified else "low",
            allowed_tool_categories=_INTENT_CATEGORIES["order_status"],
            reason="order_lookup",
        )

    if _FACILITY.search(utterance) or (
        _PERIODICAL.search(utterance) and re.search(r"\b(allow|permit|send|deliver)\b", lower)
    ) or (
        _DELIVERY_ISSUE.search(utterance) and (_FACILITY.search(utterance) or _ORDER_NUM.search(utterance))
    ):
        return SupervisorResult(
            intent="facility_question",
            confidence=0.94,
            needs_tools=True,
            needs_planner=True,
            risk_level="medium",
            allowed_tool_categories=_INTENT_CATEGORIES["facility_question"],
            reason="facility_query",
        )

    if _SHIPPING.search(utterance):
        return SupervisorResult(
            intent="shipping_question",
            confidence=0.84,
            needs_tools=True,
            needs_planner=True,
            risk_level="low",
            allowed_tool_categories=_INTENT_CATEGORIES["shipping_question"],
            reason="shipping_query",
        )

    if _CART.search(utterance):
        return SupervisorResult(
            intent="cart_update",
            confidence=0.92,
            needs_tools=True,
            needs_planner=True,
            risk_level="medium",
            allowed_tool_categories=_INTENT_CATEGORIES["cart_update"],
            reason="cart_query",
        )

    if "policy" in lower or "faq" in lower or "hours" in lower:
        return SupervisorResult(
            intent="faq",
            confidence=0.75,
            needs_tools=True,
            needs_planner=True,
            risk_level="low",
            allowed_tool_categories=_INTENT_CATEGORIES["faq"],
            reason="faq_query",
        )

    return SupervisorResult(
        intent="unknown",
        confidence=0.4,
        needs_tools=False,
        clarifying_question="Are you looking for a book, checking an order, or something else?",
        reason="low_confidence",
    )


def _has_order_verification(text: str, session: "SessionState | None") -> bool:
    if "@" in text:
        return True
    if session and (getattr(session, "verified_email", False) or getattr(session, "verified_phone", False)):
        return True
    if session and getattr(session, "confirmed_email", ""):
        return True
    digits = re.sub(r"\D", "", text)
    return len(digits) >= 10


def _asks_sensitive_order_detail(lower: str) -> bool:
    return any(
        tok in lower
        for tok in (
            "line item", "what did i order", "books in", "books are in",
            "tracking", "refund amount", "shipping address", "payment", "card",
        )
    )
