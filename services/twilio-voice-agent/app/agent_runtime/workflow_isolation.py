"""
Workflow isolation — one active business workflow per turn.

Order lookup, product/ISBN search, commerce cart, payment email, and support
handoff each own their session flags. This module decides which workflow may
handle the current turn so they do not cross-contaminate.
"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

WORKFLOW_ISOLATION_VERSION = "v1.0"

WORKFLOW_IDLE = "idle"
WORKFLOW_SUPPORT = "support_handoff"
WORKFLOW_PAYMENT = "payment"
WORKFLOW_ORDER = "order"
WORKFLOW_COMMERCE = "commerce_cart"
WORKFLOW_PRODUCT = "product_search"

_ORDER_PASSIVE_PAT = re.compile(
    r"\b(?:last\s*(?:four|4)|card|credit\s*card|refund|email|"
    r"repeat|order\s+number|what did you (?:say|find)|"
    r"customer\s*name|total|subtotal|shipping|tracking)\b",
    re.I,
)


def support_handoff_active(session: "SessionState") -> bool:
    return bool(getattr(session, "awaiting_not_found_escalation_email", False))


def payment_workflow_active(session: "SessionState", turn_mode: str = "") -> bool:
    """Payment / multi-email capture — never overlaps support handoff."""
    if support_handoff_active(session):
        return False
    mode = (turn_mode or "").strip().lower()
    if mode == "email":
        return True
    if getattr(session, "awaiting_payment_email", False):
        return True
    if getattr(session, "awaiting_payment_email_confirmation", False):
        return True
    pfs = getattr(session, "payment_flow_status", "idle") or "idle"
    if pfs in (
        "awaiting_email",
        "awaiting_email_confirmation",
        "awaiting_send_confirmation",
        "payment_sent",
    ):
        return True
    from ..agent_runtime.commerce_flow_state import STATUS_AWAITING_EMAIL_COLLECTION

    if (getattr(session, "commerce_flow_status", "idle") or "idle") == STATUS_AWAITING_EMAIL_COLLECTION:
        return True
    return False


def order_workflow_active(session: "SessionState", turn_mode: str = "") -> bool:
    """Collecting or looking up an order number — blocks product/payment paths."""
    if support_handoff_active(session) or payment_workflow_active(session, turn_mode):
        return False
    from .order_flow_state import (
        STATUS_AWAITING_ORDER_NUMBER,
        STATUS_AWAITING_ORDER_VERIFICATION,
    )

    mode = (turn_mode or "").strip().lower()
    if mode == "order":
        return True
    ofs = getattr(session, "order_flow_status", "idle") or "idle"
    if ofs in (STATUS_AWAITING_ORDER_NUMBER, STATUS_AWAITING_ORDER_VERIFICATION):
        return True
    return False


def order_context_on_call(session: "SessionState") -> bool:
    return bool(
        (getattr(session, "last_order_number", "") or "").strip()
        or (getattr(session, "order_last_voice_reply", "") or "").strip()
    )


def commerce_workflow_active(session: "SessionState") -> bool:
    if support_handoff_active(session) or payment_workflow_active(session):
        return False
    from .commerce_flow_state import commerce_flow_active

    return commerce_flow_active(session)


def product_workflow_active(
    session: "SessionState",
    turn_mode: str = "",
    text: str = "",
) -> bool:
    if support_handoff_active(session) or payment_workflow_active(session, turn_mode):
        return False
    if order_workflow_active(session, turn_mode):
        return False
    mode = (turn_mode or "").strip().lower()
    if mode == "isbn":
        return True
    if getattr(session, "pending_isbn_buffer", ""):
        return True
    try:
        from .isbn_short_circuit import _isbn_collection_active

        if _isbn_collection_active(session, turn_mode):
            return True
    except Exception:  # noqa: BLE001
        pass
    if mode == "order":
        return False
    return False


def resolve_primary_workflow(
    session: "SessionState",
    turn_mode: str = "",
    text: str = "",
) -> str:
    """
    Single workflow owner for this turn (strict priority).

    support > payment > order > commerce > product > idle
    """
    if support_handoff_active(session):
        return WORKFLOW_SUPPORT
    if payment_workflow_active(session, turn_mode):
        return WORKFLOW_PAYMENT
    from .order_flow_state import (
        extract_order_number,
        is_actionable_order_number,
        order_intent_detected,
    )

    if order_intent_detected(text or ""):
        num = extract_order_number(text, session, turn_mode=turn_mode) or ""
        if not num or not is_actionable_order_number(num):
            return WORKFLOW_ORDER
    if order_workflow_active(session, turn_mode):
        return WORKFLOW_ORDER
    if commerce_workflow_active(session):
        return WORKFLOW_COMMERCE
    if product_workflow_active(session, turn_mode, text):
        return WORKFLOW_PRODUCT
    return WORKFLOW_IDLE


def support_handling_allowed(
    session: "SessionState",
    turn_mode: str = "",
    text: str = "",
) -> bool:
    return resolve_primary_workflow(session, turn_mode, text) == WORKFLOW_SUPPORT


def payment_handling_allowed(
    session: "SessionState",
    turn_mode: str = "",
    text: str = "",
) -> bool:
    return resolve_primary_workflow(session, turn_mode, text) == WORKFLOW_PAYMENT


def order_handling_allowed(
    session: "SessionState",
    turn_mode: str = "",
    text: str = "",
) -> bool:
    from ..runtime.fast_classifier import _is_cancellation_request
    from .order_flow_state import (
        _COMMERCE_BUY_INTENT,
        extract_order_number,
        is_actionable_order_number,
        order_intent_detected,
    )

    if _is_cancellation_request(text or ""):
        return False

    if order_intent_detected(text or ""):
        wf = resolve_primary_workflow(session, turn_mode, text)
        if wf in (WORKFLOW_SUPPORT, WORKFLOW_PAYMENT):
            return False
        return True

    wf = resolve_primary_workflow(session, turn_mode, text)
    if wf == WORKFLOW_ORDER:
        return True
    if wf != WORKFLOW_IDLE:
        return False
    if not order_context_on_call(session):
        return False

    if _COMMERCE_BUY_INTENT.search(text or "") and not order_intent_detected(text or ""):
        return False
    if extract_order_number(text, session, turn_mode=turn_mode) and is_actionable_order_number(
        extract_order_number(text, session, turn_mode=turn_mode) or "",
    ):
        return True
    if _ORDER_PASSIVE_PAT.search(text or ""):
        return True
    return False


def product_handling_allowed(
    session: "SessionState",
    turn_mode: str = "",
    text: str = "",
) -> bool:
    wf = resolve_primary_workflow(session, turn_mode, text)
    if wf == WORKFLOW_PRODUCT:
        return True
    if wf != WORKFLOW_IDLE:
        return False
    from .isbn_short_circuit import payment_email_context_active

    if payment_email_context_active(session, turn_mode):
        return False
    from ..tools.isbn import extract_isbn_candidate

    if extract_isbn_candidate(text or ""):
        return True
    return False


def commerce_handling_allowed(
    session: "SessionState",
    turn_mode: str = "",
    text: str = "",
) -> bool:
    wf = resolve_primary_workflow(session, turn_mode, text)
    if wf == WORKFLOW_COMMERCE:
        return True
    if wf != WORKFLOW_IDLE:
        return False
    from .order_flow_state import order_intent_detected

    if order_intent_detected(text or ""):
        return False
    return True


def commerce_silent_advance_allowed(
    session: "SessionState",
    turn_mode: str = "",
    text: str = "",
) -> bool:
    """Commerce state may advance only inside commerce or idle shopping turns."""
    wf = resolve_primary_workflow(session, turn_mode, text)
    if wf in (WORKFLOW_SUPPORT, WORKFLOW_PAYMENT, WORKFLOW_ORDER):
        return False
    if wf == WORKFLOW_COMMERCE:
        return True
    if wf == WORKFLOW_PRODUCT:
        return False
    from .commerce_flow_state import commerce_blocks_open_commerce

    if commerce_blocks_open_commerce(session):
        return False
    return True


def isolate_workflow_buffers(
    session: "SessionState",
    turn_mode: str = "",
    text: str = "",
) -> str:
    """
    Drop cross-workflow buffers so ISBN digits do not become order numbers, etc.
    Returns the resolved workflow label for logging.
    """
    wf = resolve_primary_workflow(session, turn_mode, text)

    if wf in (WORKFLOW_SUPPORT, WORKFLOW_PAYMENT):
        session.pending_isbn_buffer = ""

    if wf == WORKFLOW_ORDER:
        session.pending_isbn_buffer = ""

    if wf == WORKFLOW_PRODUCT:
        from .order_flow_state import STATUS_AWAITING_ORDER_NUMBER

        if (getattr(session, "order_flow_status", "idle") or "idle") == STATUS_IDLE:
            pass

    return wf
