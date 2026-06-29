"""Block system-prompt / internal instruction leakage in customer-facing text (v4.7)."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

_LEAK_PHRASES: tuple[str, ...] = (
    "you are eric",
    "professional ai voice support agent",
    "available tools",
    "critical tool usage rules",
    "tool usage",
    "backend tool",
    "raw json",
    "hidden fields",
    "system instructions",
    "developer message",
    "role=tool",
    "# voice style",
    "# opening greeting",
    "# domain context",
    "do not expose",
    "never mention that you are an ai",
    # v4.8: client business rules — never say these to a customer
    "processing fee",
    "service fee",
    "internal fee",
)

_TOOL_NAME_LEAKS: tuple[str, ...] = (
    "normalizevoiceintent",
    "getorder",
    "lookup_shopify_order_details",
    "get_order_details",
    "sureshotcatalogsearch",
    "sendpaymentlink",
    "paymentsafetyguard",
    "mainllmcomposer",
    "create_product_not_found_escalation",
)

_INTERNAL_LEAK_RE = re.compile(
    r"\b(" + "|".join(re.escape(p) for p in _TOOL_NAME_LEAKS) + r")\b",
    re.I,
)

_HEADING_LEAK = re.compile(r"^#\s+[A-Z]", re.MULTILINE)

_ENDING_INTENTS = frozenset({"ending_thanks", "confirmation"})
_PAYMENT_SENT_INTENTS = frozenset({"payment_sent", "payment_execute", "send_payment_link"})


@dataclass(frozen=True)
class SanitizedResponse:
    text: str
    blocked: bool = False
    reason: str = ""


def _fallback_for_intent(intent: str, payment_sent: bool = False) -> str:
    if intent in _ENDING_INTENTS or intent == "ending_thanks":
        return (
            "You're welcome. Thank you for calling SureShot Books. Have a great day."
        )
    if payment_sent or intent in _PAYMENT_SENT_INTENTS:
        return (
            "You're welcome. I sent the payment link to your email. "
            "Please check your inbox or spam folder."
        )
    return "I'm sorry about that. How can I help you next?"


def _detect_leak(text: str) -> Optional[str]:
    if not text or not text.strip():
        return None
    lower = text.lower()
    for phrase in _LEAK_PHRASES:
        if phrase in lower:
            return "system_prompt_leak"
    if _INTERNAL_LEAK_RE.search(text):
        return "system_prompt_leak"
    if _HEADING_LEAK.search(text) and (
        "voice style" in lower
        or "opening greeting" in lower
        or "domain context" in lower
        or "available tools" in lower
    ):
        return "system_prompt_leak"
    return None


def _mask_safe_log_text(text: str) -> str:
    """Mask PII for assistant_response logs."""
    if not text:
        return ""
    masked = re.sub(
        r"[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}",
        "***@***",
        text,
        flags=re.IGNORECASE,
    )
    masked = re.sub(
        r"(?:\+1)?[\s.\-]?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}",
        "***-***-****",
        masked,
    )
    masked = re.sub(
        r"https?://[^\s]+",
        "[checkout-url]",
        masked,
        flags=re.IGNORECASE,
    )
    if len(masked) > 200:
        return masked[:197] + "..."
    return masked


def log_assistant_response(
    text: str,
    *,
    call_sid: str = "",
    turn: int = 0,
    intent: str = "",
) -> None:
    """Safe assistant response log — masks email, phone, address, checkout URL."""
    safe = _mask_safe_log_text(text)
    sid = (call_sid or "")[:6]
    logger.info(
        "assistant_response sid=%s turn=%d intent=%s text_safe=%r",
        sid, turn, intent, safe,
    )


def sanitize_customer_response(
    text: str,
    *,
    intent: str = "",
    call_sid: str = "",
    payment_sent: bool = False,
) -> SanitizedResponse:
    """
    Detect and block responses containing hidden/system prompt leakage.

    Never logs the leaked prompt content.
    """
    reason = _detect_leak(text)
    if not reason:
        return SanitizedResponse(text=text, blocked=False)

    sid = (call_sid or "")[:6]
    logger.warning("response_sanitizer_blocked sid=%s reason=%s", sid, reason)
    safe = _fallback_for_intent(intent, payment_sent=payment_sent)
    return SanitizedResponse(text=safe, blocked=True, reason=reason)
