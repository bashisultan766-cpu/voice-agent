"""
Canonical voice domain workflows — exactly three execution domains.

order_workflow          → order lookup / cancellation staging
product_search_workflow → ISBN + title catalog resolution (single pipeline)
support_handoff_workflow → escalation, email capture, support notification

Payment email and commerce cart are checkout sub-states inside product_search,
not separate domain workflows.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..runtime.fast_classifier import ClassificationResult
    from ..state.models import SessionState

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
    workflow_entry_guard,
)

VOICE_WORKFLOWS_VERSION = "v1.0"

PRODUCT_CLARIFICATION_REPLY = (
    "Please provide product name or ISBN number so I can find the exact item."
)

# Legacy labels — re-exported from workflow_contracts for backward compatibility


def isbn_detected(
    session: "SessionState",
    text: str,
    turn_mode: str = "",
) -> bool:
    from .isbn_short_circuit import _looks_like_isbn_digit_stream
    from ..tools.isbn import extract_isbn_candidate

    if (turn_mode or "").strip().lower() == "isbn":
        return True
    if extract_isbn_candidate(text or ""):
        return True
    if _looks_like_isbn_digit_stream(text or ""):
        return True
    return bool(getattr(session, "pending_isbn_buffer", ""))


def product_title_detected(
    session: "SessionState",
    text: str,
    turn_mode: str = "",
) -> bool:
    from .commerce_flow_state import _status as commerce_status
    from .isbn_short_circuit import is_explicit_title_catalog_query
    from ..tools.isbn import extract_isbn_candidate

    if extract_isbn_candidate(text or ""):
        return False
    return is_explicit_title_catalog_query(
        text or "",
        commerce_status=commerce_status(session),
    )


def has_structured_product_search_input(
    session: "SessionState",
    text: str,
    turn_mode: str = "",
) -> bool:
    """ISBN or explicit title/query — required before deterministic catalog search."""
    return (
        isbn_detected(session, text, turn_mode)
        or product_title_detected(session, text, turn_mode)
    )


@dataclass
class ProductSearchTurnResult:
    force_reply: str = ""
    tool_results: list[tuple[str, dict[str, Any]]] | None = None
    isbn: str = ""
    route: str = ""


@workflow_entry_guard(PRODUCT_SEARCH_WORKFLOW, "execute_product_search_workflow")
async def execute_product_search_workflow(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
    classification: Optional["ClassificationResult"] = None,
) -> Optional[ProductSearchTurnResult]:
    """
    Single product_search_workflow execution path.

    Replaces fragmented product_catalog_hunt / product_lookup_v2 pipelines.
    """
    from ..tools.isbn import extract_isbn_candidate
    from .commerce_flow_state import _status as commerce_status
    from .isbn_short_circuit import (
        conversational_ack_reply,
        is_conversational_ack,
        is_explicit_title_catalog_query,
        isbn_partial_reply,
        try_isbn_short_circuit,
        try_title_catalog_short_circuit,
    )
    from .not_found_escalation_flow import try_product_search_fallback_escalation
    from .workflow_isolation import product_handling_allowed

    if not product_handling_allowed(session, turn_mode, caller_text):
        return None

    from ..observability.workflow_events import (
        STEP_PRODUCT_SEARCH_STARTED,
        emit_event,
    )

    search_input_type = "unknown"
    if isbn_detected(session, caller_text, turn_mode):
        search_input_type = "isbn"
    elif product_title_detected(session, caller_text, turn_mode):
        search_input_type = "title"
    search_outcome = (
        "clarify"
        if not has_structured_product_search_input(session, caller_text, turn_mode)
        else "unknown"
    )
    emit_event(
        {
            "event_type": "workflow_transition",
            "domain": "product_search",
            "step": STEP_PRODUCT_SEARCH_STARTED,
            "input_type": search_input_type,
            "outcome": search_outcome,
            "metadata": {"turn_mode": turn_mode or ""},
        },
        session=session,
    )

    fallback_reply = try_product_search_fallback_escalation(session, caller_text)
    if fallback_reply:
        return ProductSearchTurnResult(
            force_reply=fallback_reply,
            route="support_handoff_transition",
        )

    if is_conversational_ack(caller_text):
        ack = conversational_ack_reply(session, turn_mode=turn_mode)
        if ack:
            return ProductSearchTurnResult(force_reply=ack, route="conversational_ack")

    if not has_structured_product_search_input(session, caller_text, turn_mode):
        return ProductSearchTurnResult(
            force_reply=PRODUCT_CLARIFICATION_REPLY,
            route="clarification",
        )

    if isbn_detected(session, caller_text, turn_mode):
        sc = await try_isbn_short_circuit(session, caller_text, turn_mode=turn_mode)
        if sc and sc.force_reply:
            return ProductSearchTurnResult(
                force_reply=sc.force_reply,
                tool_results=sc.tool_results,
                isbn=sc.isbn or "",
                route="isbn_resolve",
            )
        partial = isbn_partial_reply(session, caller_text, turn_mode=turn_mode)
        if partial:
            return ProductSearchTurnResult(force_reply=partial, route="isbn_partial")
        return ProductSearchTurnResult(
            force_reply=PRODUCT_CLARIFICATION_REPLY,
            route="clarification",
        )

    if (
        is_explicit_title_catalog_query(
            caller_text,
            commerce_status=commerce_status(session),
        )
        and not extract_isbn_candidate(caller_text)
    ):
        sc = await try_title_catalog_short_circuit(
            session, caller_text, turn_mode=turn_mode,
        )
        if sc and sc.force_reply:
            return ProductSearchTurnResult(
                force_reply=sc.force_reply,
                tool_results=sc.tool_results,
                isbn=sc.isbn or "",
                route="title_resolve",
            )
        return ProductSearchTurnResult(
            force_reply=PRODUCT_CLARIFICATION_REPLY,
            route="clarification",
        )

    if classification and classification.is_product_search:
        return ProductSearchTurnResult(
            force_reply=PRODUCT_CLARIFICATION_REPLY,
            route="clarification",
        )

    return ProductSearchTurnResult(
        force_reply=PRODUCT_CLARIFICATION_REPLY,
        route="clarification",
    )


@workflow_entry_guard(SUPPORT_HANDOFF_WORKFLOW, "execute_support_handoff_workflow")
async def execute_support_handoff_workflow(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> Optional[Any]:
    """
    Single support_handoff_workflow execution path.

    Replaces fallback_support_flow and duplicate runtime handoff blocks.
    """
    from .not_found_escalation_flow import (
        NotFoundEscalationTurnHint,
        clear_pending_escalation,
        process_not_found_escalation_turn,
        should_clear_handoff_for_shopping,
    )
    from .workflow_isolation import support_handling_allowed

    if not support_handling_allowed(session, turn_mode, caller_text):
        return None

    if should_clear_handoff_for_shopping(session, caller_text, turn_mode=turn_mode):
        clear_pending_escalation(session)
        return NotFoundEscalationTurnHint()

    return await process_not_found_escalation_turn(
        session, caller_text, turn_mode=turn_mode,
    )
