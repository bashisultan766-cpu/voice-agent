"""Deterministic call wrap-up — anything else? then hang up."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

_ANYTHING_ELSE_PROMPT = "Is there anything else I can help you with today?"
_GOODBYE_REPLY = (
    "Thank you for calling SureShot Books. Have a great day. Goodbye!"
)

_DECLINE_PAT = re.compile(
    r"^\s*("
    r"no|nope|nah|no thanks|no thank you|nothing else|that'?s all|that is all|"
    r"i'?m good|i am good|all set|we'?re good|that'?s it|that is it|"
    r"nothing|not really|don'?t need anything else"
    r")\s*[.!]*\s*$",
    re.I,
)
_GOODBYE_PAT = re.compile(
    r"\b(goodbye|bye bye|bye|hang up|end the call|end call|that'?s all for now)\b",
    re.I,
)
_THANKS_DONE_PAT = re.compile(
    r"^\s*(thanks|thank you)(,?\s+(that'?s all|bye|goodbye))?\s*[.!]*\s*$",
    re.I,
)


@dataclass
class CallClosureResult:
    reply: str
    end_call: bool = False


def mark_awaiting_anything_else(session: "SessionState") -> None:
    session.awaiting_anything_else = True


def offer_anything_else_suffix() -> str:
    return f" {_ANYTHING_ELSE_PROMPT}"


def process_call_closure_turn(
    session: "SessionState",
    caller_text: str,
) -> Optional[CallClosureResult]:
    """Handle goodbye / no-more-help turns without LLM silence."""
    text = (caller_text or "").strip()
    if not text:
        return None

    if getattr(session, "awaiting_anything_else", False):
        if _DECLINE_PAT.match(text) or _THANKS_DONE_PAT.match(text):
            session.awaiting_anything_else = False
            return CallClosureResult(reply=_GOODBYE_REPLY, end_call=True)
        if _GOODBYE_PAT.search(text):
            session.awaiting_anything_else = False
            return CallClosureResult(reply=_GOODBYE_REPLY, end_call=True)
        if re.match(r"^\s*(yes|yeah|yep|sure|ok|okay)\s*[.!]*\s*$", text, re.I):
            session.awaiting_anything_else = False
            return CallClosureResult(
                reply="Sure — what else can I help you with? You can add another book, "
                "check an order, or ask about facility rules.",
            )

    if _GOODBYE_PAT.search(text) and not _active_blocking_flow(session):
        session.awaiting_anything_else = False
        return CallClosureResult(reply=_GOODBYE_REPLY, end_call=True)

    return None


def _active_blocking_flow(session: "SessionState") -> bool:
    if getattr(session, "payment_link_sent", False):
        return False
    if getattr(session, "awaiting_anything_else", False):
        return False
    if getattr(session, "awaiting_payment_email_confirmation", False):
        return True
    if getattr(session, "awaiting_payment_email", False):
        return True
    commerce = getattr(session, "commerce_flow_status", "") or "idle"
    if commerce not in ("idle", "", "awaiting_another_book"):
        return True
    if getattr(session, "commerce_pending_candidate", None):
        return True
    if getattr(session, "awaiting_product_confirmation", False):
        return True
    return False
