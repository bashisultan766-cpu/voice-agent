"""
Compound intent extraction (v4.4).

Parses multi-goal utterances like payment + email + cart count in one turn.
"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING, Optional

from .router import IntentResult, detect as base_detect

if TYPE_CHECKING:
    from ..state.models import SessionState

_PAYMENT_PHRASES = re.compile(
    r"\b("
    r"send (?:me )?(?:the )?payment link"
    r"|send (?:me )?(?:the )?link"
    r"|payment link"
    r"|send (?:it|this|them)"
    r"|checkout"
    r")\b",
    re.IGNORECASE,
)
_CART_COUNT_REF = re.compile(
    r"\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:isbn|books?)\b",
    re.IGNORECASE,
)
_GAVE_YOU = re.compile(
    r"\bi gave you (\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b",
    re.IGNORECASE,
)
_PAYMENT_STATUS = re.compile(
    r"\b(did you send|have you sent|was it sent|did you send this|send it yet)\b",
    re.IGNORECASE,
)
_SPELL_THIS = re.compile(
    r"\b(spell this|read this back|what did you hear)\b",
    re.IGNORECASE,
)

_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}


def _parse_count(m: re.Match) -> int:
    val = m.group(1).lower()
    return int(val) if val.isdigit() else _WORDS.get(val, 0)


def enhance_intent(
    text: str,
    session: Optional["SessionState"],
    result: IntentResult,
) -> IntentResult:
    """
    Post-process router result for compound utterances.
    Payment request takes priority over bare email_provided when both present.
    """
    t = text.strip()
    entities = dict(result.entities)
    entities["raw_text"] = t

    payment_requested = bool(_PAYMENT_PHRASES.search(t))
    if payment_requested:
        entities["payment_requested"] = "true"

    m = _CART_COUNT_REF.search(t) or _GAVE_YOU.search(t)
    if m:
        entities["requested_cart_count"] = str(_parse_count(m))

    # Payment status question
    if _PAYMENT_STATUS.search(t):
        return IntentResult(
            intent="payment_status_question",
            confidence=0.92,
            entities=entities,
        )

    # "spell this" in email context
    if _SPELL_THIS.search(t) and session:
        pfs = getattr(session, "payment_flow_status", "idle") or "idle"
        flow = ""
        if getattr(session, "dialogue", None):
            d = session.dialogue
            flow = getattr(d, "active_flow", "")
        if (
            getattr(session, "pending_email", "")
            or getattr(session, "confirmed_email", "")
            or pfs.startswith("awaiting_email")
            or flow in ("email_collection", "email_confirmation", "payment_final_confirmation")
        ):
            return IntentResult(
                intent="spell_email_request",
                confidence=0.93,
                entities=entities,
            )

    # Compound: payment + email in same turn
    has_email = bool(entities.get("email"))
    if payment_requested and has_email:
        entities["needs_email_confirmation"] = "true"
        # If payment is primary, route send_payment_link; email applied via _apply_email_state
        if result.intent in ("email_provided", "unknown", "confirmation"):
            return IntentResult(
                intent="send_payment_link",
                confidence=0.90,
                entities=entities,
            )

    if payment_requested and result.intent not in (
        "send_payment_link", "payment_execute", "checkout_request", "payment_status_question",
    ):
        return IntentResult(
            intent="send_payment_link",
            confidence=0.88,
            entities=entities,
        )

    # Preserve entities on original result
    result.entities = entities
    return result


def detect(text: str, session: Optional["SessionState"] = None) -> IntentResult:
    """Router entry with compound enhancement."""
    result = base_detect(text, session)
    return enhance_intent(text, session, result)
