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
    r"nothing|not really|don'?t need anything else|i'?m done|i am done"
    r")\s*[.!]*\s*$",
    re.I,
)
_DECLINE_LOOSE_PAT = re.compile(
    r"\bno\b.*\b(that'?s all|nothing else|thank you|thanks)\b",
    re.I,
)
_GOODBYE_PAT = re.compile(
    r"\b("
    r"goodbye|bye bye|bye|see you|see ya|talk to you later|"
    r"hang up|end the call|end call|cut the call|cut call|"
    r"that'?s all for now|have a (?:good|nice) day"
    r")\b",
    re.I,
)
_THANKS_DONE_PAT = re.compile(
    r"^\s*(thanks|thank you)(,?\s+(that'?s all|bye|goodbye|see you))?\s*[.!]*\s*$",
    re.I,
)
_THANKS_SEE_YOU_PAT = re.compile(
    r"\b(thank you|thanks)\b.*\b(see you|bye|goodbye)\b",
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


def caller_wants_to_end(text: str) -> bool:
    """True when the caller is clearly ending the conversation."""
    t = (text or "").strip()
    if not t:
        return False
    if _DECLINE_PAT.match(t) or _DECLINE_LOOSE_PAT.search(t):
        return True
    if _THANKS_DONE_PAT.match(t) or _THANKS_SEE_YOU_PAT.search(t):
        return True
    return bool(_GOODBYE_PAT.search(t))


def process_call_closure_turn(
    session: "SessionState",
    caller_text: str,
) -> Optional[CallClosureResult]:
    """Handle goodbye / no-more-help turns without LLM silence."""
    text = (caller_text or "").strip()
    if not text:
        return None

    if getattr(session, "awaiting_anything_else", False):
        if caller_wants_to_end(text):
            session.awaiting_anything_else = False
            return CallClosureResult(reply=_GOODBYE_REPLY, end_call=True)
        from ..agent_runtime.yes_engagement import is_bare_yes

        if is_bare_yes(text):
            session.awaiting_anything_else = False
            return CallClosureResult(
                reply="Sure — what else can I help you with? You can add another book, "
                "check an order, or ask about facility rules.",
            )

    if caller_wants_to_end(text) and not _active_blocking_flow(session):
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
