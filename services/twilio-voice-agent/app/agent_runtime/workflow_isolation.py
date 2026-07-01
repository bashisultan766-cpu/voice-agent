"""
Workflow isolation — one active business workflow per turn.

Canonical domains (see voice_workflows.py):
  order_workflow, product_search_workflow, support_handoff_workflow

Payment checkout and commerce cart are sub-states of product_search, not
separate domain workflows.
"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING

from .workflow_contracts import (
    ORDER_WORKFLOW,
    PRODUCT_SEARCH_WORKFLOW,
    SUPPORT_HANDOFF_WORKFLOW,
    WORKFLOW_COMMERCE,
    WORKFLOW_IDLE,
    WORKFLOW_ORDER,
    WORKFLOW_PAYMENT,
    WORKFLOW_PRODUCT,
    WORKFLOW_SUPPORT,
)

if TYPE_CHECKING:
    from ..state.models import SessionState

WORKFLOW_ISOLATION_VERSION = "v1.3"

# ── ProductCommerceState FSM (mirrors order_flow_state pattern) ─────────────

PRODUCT_COMMERCE_FSM_VERSION = "v1.0"

PCS_IDLE = "idle"
PCS_DISCOVERY = "discovery"
PCS_PRODUCT_SELECTED = "product_selected"
PCS_AWAITING_QUANTITY = "awaiting_quantity"
PCS_CART_BUILDING = "cart_building"
PCS_CART_CONFIRMED = "cart_confirmed"
PCS_PAYMENT_READY = "payment_ready"

_ALL_PCS_STATES = frozenset({
    PCS_IDLE,
    PCS_DISCOVERY,
    PCS_PRODUCT_SELECTED,
    PCS_AWAITING_QUANTITY,
    PCS_CART_BUILDING,
    PCS_CART_CONFIRMED,
    PCS_PAYMENT_READY,
})

_PCS_LLM_BLOCKED = frozenset({
    PCS_PRODUCT_SELECTED,
    PCS_AWAITING_QUANTITY,
    PCS_CART_BUILDING,
    PCS_CART_CONFIRMED,
    PCS_PAYMENT_READY,
})

_PCS_ACTIVE = _ALL_PCS_STATES - {PCS_IDLE}


def product_commerce_status(session: "SessionState") -> str:
    """Current ProductCommerceState for this call."""
    stored = (getattr(session, "product_commerce_status", "") or "").strip()
    if stored in _ALL_PCS_STATES:
        return stored
    return PCS_IDLE


def derive_product_commerce_status(
    session: "SessionState",
    text: str = "",
    *,
    turn_mode: str = "",
) -> str:
    """
    Derive ProductCommerceState from commerce cart + payment sub-states.

    Does not modify order flow fields.
    """
    if order_workflow_active(session, turn_mode):
        return PCS_IDLE

    from .commerce_flow_state import (
        STATUS_AWAITING_ADD_CONFIRM,
        STATUS_AWAITING_ANOTHER_BOOK,
        STATUS_AWAITING_BOOK_CONFIRM,
        STATUS_AWAITING_EMAIL_COLLECTION,
        STATUS_AWAITING_QUANTITY,
        _cart_has_confirmed_items,
        _status as commerce_status,
    )

    cfs = commerce_status(session)

    if payment_workflow_active(session, turn_mode) or cfs == STATUS_AWAITING_EMAIL_COLLECTION:
        if _cart_has_confirmed_items(session):
            return PCS_PAYMENT_READY

    if cfs == STATUS_AWAITING_QUANTITY:
        return PCS_AWAITING_QUANTITY

    if cfs in (STATUS_AWAITING_ADD_CONFIRM, STATUS_AWAITING_ANOTHER_BOOK):
        return PCS_CART_BUILDING

    if cfs == STATUS_AWAITING_BOOK_CONFIRM:
        return PCS_PRODUCT_SELECTED

    if _cart_has_confirmed_items(session):
        return PCS_CART_CONFIRMED

    candidate = dict(getattr(session, "commerce_pending_candidate", None) or {})
    if candidate.get("variant_id") or getattr(session, "awaiting_product_confirmation", False):
        return PCS_PRODUCT_SELECTED

    mode = (turn_mode or "").strip().lower()
    if mode == "isbn" or getattr(session, "pending_isbn_buffer", ""):
        return PCS_DISCOVERY

    try:
        from .isbn_short_circuit import _isbn_collection_active

        if _isbn_collection_active(session, turn_mode):
            return PCS_DISCOVERY
    except Exception:  # noqa: BLE001
        pass

    from ..runtime.fast_classifier import product_intent_detected

    if product_intent_detected(text or ""):
        return PCS_DISCOVERY

    if product_handling_allowed(session, turn_mode, text):
        return PCS_DISCOVERY

    return PCS_IDLE


def sync_product_commerce_state(
    session: "SessionState",
    text: str = "",
    *,
    turn_mode: str = "",
) -> str:
    """Persist ProductCommerceState on the session (order flow untouched)."""
    if order_workflow_active(session, turn_mode):
        session.product_commerce_status = PCS_IDLE
        return PCS_IDLE

    status = derive_product_commerce_status(session, text, turn_mode=turn_mode)
    session.product_commerce_status = status
    return status


def product_commerce_fsm_active(session: "SessionState") -> bool:
    return product_commerce_status(session) in _PCS_ACTIVE


def product_commerce_blocks_llm(session: "SessionState") -> bool:
    """Active cart/checkout steps — LLM must not decide routing (classifier still runs)."""
    return product_commerce_status(session) in _PCS_LLM_BLOCKED


def product_commerce_requires_classifier(session: "SessionState") -> bool:
    """Any non-idle product commerce turn must pass through classify() before brain."""
    return product_commerce_status(session) != PCS_IDLE


def product_commerce_orchestrator_route(session: "SessionState") -> str:
    """Deterministic orchestrator fast_route for blocked product-commerce stages."""
    pcs = product_commerce_status(session)
    if pcs == PCS_DISCOVERY:
        return "product_search_workflow"
    if pcs in _PCS_LLM_BLOCKED:
        return "product_commerce_fsm"
    return ""


_ORDER_PASSIVE_PAT = re.compile(
    r"\b(?:last\s*(?:four|4)|card|credit\s*card|refund|email|"
    r"repeat|order\s+number|what did you (?:say|find)|"
    r"customer\s*name|total|subtotal|shipping|tracking)\b",
    re.I,
)


def support_handoff_active(session: "SessionState") -> bool:
    return bool(getattr(session, "awaiting_not_found_escalation_email", False))


def payment_workflow_active(session: "SessionState", turn_mode: str = "") -> bool:
    """Payment / multi-email capture — cart checkout email beats stale support handoff."""
    mode = (turn_mode or "").strip().lower()
    if support_handoff_active(session) and mode == "email":
        from ..payment.payment_state_machine import _cart_has_confirmed_items

        if _cart_has_confirmed_items(session):
            return True
        pfs = getattr(session, "payment_flow_status", "idle") or "idle"
        if pfs in ("awaiting_email", "awaiting_email_confirmation", "awaiting_send_confirmation"):
            return True
    if support_handoff_active(session):
        return False
    from .commerce_flow_state import (
        STATUS_AWAITING_EMAIL_COLLECTION,
        commerce_cart_building_active,
        _status as commerce_status,
    )

    if commerce_cart_building_active(session):
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
    if commerce_status(session) == STATUS_AWAITING_EMAIL_COLLECTION:
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
        return SUPPORT_HANDOFF_WORKFLOW
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
            return ORDER_WORKFLOW
    if order_workflow_active(session, turn_mode):
        return ORDER_WORKFLOW
    from ..tools.isbn import extract_isbn_candidate

    mode = (turn_mode or "").strip().lower()
    if (
        mode == "isbn"
        or extract_isbn_candidate(text or "")
        or getattr(session, "pending_isbn_buffer", "")
    ):
        return PRODUCT_SEARCH_WORKFLOW
    if commerce_workflow_active(session):
        return WORKFLOW_COMMERCE
    try:
        from .isbn_short_circuit import (
            catalog_title_search_allowed,
            is_explicit_title_catalog_query,
        )
        from .commerce_flow_state import _status as commerce_status

        if (
            catalog_title_search_allowed(session, turn_mode)
            and is_explicit_title_catalog_query(
                text or "",
                commerce_status=commerce_status(session),
            )
            and not extract_isbn_candidate(text or "")
        ):
            return PRODUCT_SEARCH_WORKFLOW
    except Exception:  # noqa: BLE001
        pass
    if product_workflow_active(session, turn_mode, text):
        return PRODUCT_SEARCH_WORKFLOW
    return WORKFLOW_IDLE


def support_handling_allowed(
    session: "SessionState",
    turn_mode: str = "",
    text: str = "",
) -> bool:
    return resolve_primary_workflow(session, turn_mode, text) == SUPPORT_HANDOFF_WORKFLOW


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
        is_order_followup_question,
        order_intent_detected,
    )

    if _is_cancellation_request(text or ""):
        return False

    if order_intent_detected(text or ""):
        wf = resolve_primary_workflow(session, turn_mode, text)
        if wf in (SUPPORT_HANDOFF_WORKFLOW, WORKFLOW_PAYMENT):
            return False
        return True

    wf = resolve_primary_workflow(session, turn_mode, text)
    if wf == ORDER_WORKFLOW:
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
    if is_order_followup_question(text or ""):
        return True
    return False


def product_handling_allowed(
    session: "SessionState",
    turn_mode: str = "",
    text: str = "",
) -> bool:
    wf = resolve_primary_workflow(session, turn_mode, text)
    if wf == PRODUCT_SEARCH_WORKFLOW:
        return True
    if wf != WORKFLOW_IDLE:
        return False
    from .isbn_short_circuit import payment_email_context_active

    if payment_email_context_active(session, turn_mode):
        return False
    from .isbn_short_circuit import (
        catalog_title_search_allowed,
        is_explicit_title_catalog_query,
    )
    from .commerce_flow_state import _status as commerce_status
    from ..tools.isbn import extract_isbn_candidate

    mode = (turn_mode or "").strip().lower()
    if mode == "isbn" or extract_isbn_candidate(text or ""):
        return True
    if (
        catalog_title_search_allowed(session, turn_mode)
        and is_explicit_title_catalog_query(
            text or "",
            commerce_status=commerce_status(session),
        )
        and not extract_isbn_candidate(text or "")
    ):
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
    if wf in (SUPPORT_HANDOFF_WORKFLOW, WORKFLOW_PAYMENT, ORDER_WORKFLOW):
        return False
    if wf == PRODUCT_SEARCH_WORKFLOW:
        return False
    from .commerce_flow_state import (
        STATUS_AWAITING_ADD_CONFIRM,
        STATUS_AWAITING_QUANTITY,
        commerce_blocks_open_commerce,
    )
    from .commerce_flow_state import _status as commerce_status

    if commerce_blocks_open_commerce(session):
        return False
    if commerce_status(session) in (STATUS_AWAITING_QUANTITY, STATUS_AWAITING_ADD_CONFIRM):
        return False
    if wf == WORKFLOW_COMMERCE:
        return True
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

    if wf in (SUPPORT_HANDOFF_WORKFLOW, WORKFLOW_PAYMENT):
        session.pending_isbn_buffer = ""
        if wf == WORKFLOW_PAYMENT and support_handoff_active(session):
            from .not_found_escalation_flow import clear_pending_escalation

            clear_pending_escalation(session)

    if wf == ORDER_WORKFLOW:
        session.pending_isbn_buffer = ""

    if wf == PRODUCT_SEARCH_WORKFLOW:
        from .order_flow_state import STATUS_AWAITING_ORDER_NUMBER, STATUS_IDLE

        ofs = getattr(session, "order_flow_status", "idle") or "idle"
        if ofs == STATUS_AWAITING_ORDER_NUMBER:
            session.order_flow_status = STATUS_IDLE

    return wf
