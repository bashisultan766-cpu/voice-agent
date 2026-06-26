"""Fast spoken acknowledgements before slow tool execution (orchestrator path)."""
from __future__ import annotations

import re
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from ..state.models import SessionState
    from .types import PlannerResult, SupervisorResult

_BARE_CONFIRM = re.compile(
    r"^\s*(yes|yeah|yep|yup|sure|ok|okay|correct|right|go ahead|no|nope)\s*[.!]*\s*$",
    re.I,
)


def should_send_progress_ack(
    session: "SessionState",
    *,
    turn_mode: str = "",
    supervisor: Optional["SupervisorResult"] = None,
) -> bool:
    """Skip ack for payment FSM, email confirmation, and bare yes/no turns."""
    mode = (turn_mode or "").lower()
    if mode in ("email",):
        return False
    if getattr(session, "awaiting_payment_email_confirmation", False):
        return False
    if getattr(session, "payment_flow_status", "") in (
        "awaiting_email_confirmation",
        "awaiting_send_confirmation",
        "awaiting_email",
    ):
        return False
    if supervisor and supervisor.intent == "identity_email_collection":
        return False
    if supervisor and supervisor.intent == "checkout_payment":
        return False
    return True


def resolve_progress_message(
    supervisor: "SupervisorResult",
    planner: "PlannerResult",
    user_text: str = "",
) -> str:
    """Short natural acknowledgement — never claims a result."""
    if planner.customer_facing_progress_message:
        return planner.customer_facing_progress_message.strip()

    intent = supervisor.intent
    lower = (user_text or "").lower()

    if intent == "product_search":
        if re.search(r"\b(?:97[89]\d{10}|\d{13})\b", user_text or ""):
            return "Let me check that ISBN."
        return "I'll look that up."
    if intent == "order_status":
        return "Let me check that order."
    if intent == "refund_status":
        return "I'll check the refund status."
    if intent == "facility_question":
        return "I'll check that facility policy."
    if intent == "cart_update":
        return "Let me check your cart."
    if intent == "shipping_question":
        return "One moment — I'll pull up shipping info."
    if intent == "faq":
        return "Let me check that for you."
    if intent == "escalation":
        return "I'll connect you with our team."
    if "order" in lower:
        return "Let me check that order."
    return ""
