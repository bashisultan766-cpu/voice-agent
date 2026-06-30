"""
Canonical voice domain workflows — exactly three execution domains.

order_workflow          → order lookup / cancellation staging
product_search_workflow → ISBN + title catalog resolution (single pipeline)
support_handoff_workflow → escalation, email capture, support notification

Payment email and commerce cart are checkout sub-states inside product_search,
not separate domain workflows.
"""
from __future__ import annotations

import logging
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

logger = logging.getLogger(__name__)

VOICE_WORKFLOWS_VERSION = "v1.1"

PRODUCT_CLARIFICATION_REPLY = "Please provide ISBN or book title."

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
    return has_valid_product_identifier(session, text, turn_mode)


def has_valid_product_identifier(
    session: "SessionState",
    text: str,
    turn_mode: str = "",
) -> bool:
    """
    Complete ISBN or explicit actionable title only.

    Partial digit buffers and vague product intent do not qualify.
    """
    from ..tools.isbn import extract_isbn_candidate
    from .commerce_flow_state import _status as commerce_status
    from .isbn_short_circuit import (
        _catalog_query_is_actionable,
        _looks_like_isbn_digit_stream,
        extract_title_catalog_query,
        is_explicit_title_catalog_query,
        resolve_spoken_isbn,
    )

    cleaned = (text or "").strip()
    if not cleaned:
        return False

    isbn = extract_isbn_candidate(cleaned)
    if isbn and len(isbn) == 13:
        return True

    resolved, _buf = resolve_spoken_isbn(cleaned, session=session, turn_mode=turn_mode)
    if resolved and len(resolved) == 13:
        return True

    if _buf or getattr(session, "pending_isbn_buffer", ""):
        return False
    if (turn_mode or "").strip().lower() == "isbn" and not resolved:
        return False
    if _looks_like_isbn_digit_stream(cleaned) and not resolved:
        return False

    if extract_isbn_candidate(cleaned):
        return False

    if is_explicit_title_catalog_query(
        cleaned,
        commerce_status=commerce_status(session),
    ):
        query = extract_title_catalog_query(cleaned)
        return _catalog_query_is_actionable(query)

    return False


def _clear_partial_isbn_collection(session: "SessionState") -> None:
    session.pending_isbn_buffer = ""


def _log_product_search_ux_step(
    session: "SessionState",
    *,
    step: str,
    route: str,
    has_identifier: bool,
) -> None:
    sid = (getattr(session, "call_sid", "") or "")[:6]
    logger.info(
        "product_search_ux_step sid=%s step=%s route=%s has_identifier=%s",
        sid,
        step,
        route,
        str(has_identifier).lower(),
    )


@dataclass
class ProductSearchTurnResult:
    force_reply: str = ""
    tool_results: list[tuple[str, dict[str, Any]]] | None = None
    isbn: str = ""
    route: str = ""


async def _resolve_via_match_product(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> Optional[ProductSearchTurnResult]:
    """Step 3 — catalog lookup only after a complete ISBN or explicit title."""
    from ..tools.isbn import extract_isbn_candidate
    from .isbn_short_circuit import extract_title_catalog_query, resolve_spoken_isbn
    from .product_resolution import match_product, product_resolution_to_short_circuit

    isbn = extract_isbn_candidate(caller_text or "") or ""
    if not isbn:
        resolved, _buf = resolve_spoken_isbn(
            caller_text or "",
            session=session,
            turn_mode=turn_mode,
        )
        if resolved:
            isbn = resolved

    if isbn:
        resolution = await match_product(session, isbn=isbn)
        sc = await product_resolution_to_short_circuit(
            session,
            caller_text,
            resolution,
            isbn=isbn,
        )
        if sc and sc.force_reply:
            return ProductSearchTurnResult(
                force_reply=sc.force_reply,
                tool_results=sc.tool_results,
                isbn=sc.isbn or isbn,
                route="isbn_resolve",
            )
        return None

    query = extract_title_catalog_query(caller_text)
    resolution = await match_product(session, title=query)
    sc = await product_resolution_to_short_circuit(session, caller_text, resolution)
    if sc and sc.force_reply:
        return ProductSearchTurnResult(
            force_reply=sc.force_reply,
            tool_results=sc.tool_results,
            isbn=sc.isbn or "",
            route="title_resolve",
        )
    return None


@workflow_entry_guard(PRODUCT_SEARCH_WORKFLOW, "execute_product_search_workflow")
async def execute_product_search_workflow(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
    classification: Optional["ClassificationResult"] = None,
) -> Optional[ProductSearchTurnResult]:
    """
    Strict ElevenLabs-style product_search flow:

    1. Detect intent — no catalog search
    2. Missing ISBN/title — structured clarification only
    3. Valid identifier — match_product()
    4. No exact hit — similarity alternatives or support handoff (in resolution)
    """
    from .isbn_short_circuit import (
        conversational_ack_reply,
        is_conversational_ack,
    )
    from .not_found_escalation_flow import try_product_search_fallback_escalation
    from .workflow_isolation import product_handling_allowed

    if not product_handling_allowed(session, turn_mode, caller_text):
        return None

    from ..observability.workflow_events import (
        STEP_PRODUCT_SEARCH_STARTED,
        emit_event,
    )

    has_identifier = has_valid_product_identifier(session, caller_text, turn_mode)
    search_input_type = "unknown"
    if has_identifier:
        from ..tools.isbn import extract_isbn_candidate
        from .isbn_short_circuit import resolve_spoken_isbn

        isbn = extract_isbn_candidate(caller_text or "") or ""
        if not isbn:
            resolved, _buf = resolve_spoken_isbn(
                caller_text or "",
                session=session,
                turn_mode=turn_mode,
            )
            if resolved:
                isbn = resolved
        if isbn:
            search_input_type = "isbn"
        elif product_title_detected(session, caller_text, turn_mode):
            search_input_type = "title"

    emit_event(
        {
            "event_type": "workflow_transition",
            "domain": "product_search",
            "step": STEP_PRODUCT_SEARCH_STARTED,
            "input_type": search_input_type,
            "outcome": "clarify" if not has_identifier else "unknown",
            "metadata": {"turn_mode": turn_mode or ""},
        },
        session=session,
    )

    _log_product_search_ux_step(
        session,
        step="intent_detected",
        route="product_search_workflow",
        has_identifier=has_identifier,
    )

    fallback_reply = try_product_search_fallback_escalation(session, caller_text)
    if fallback_reply:
        _log_product_search_ux_step(
            session,
            step="support_handoff_transition",
            route="support_handoff_transition",
            has_identifier=has_identifier,
        )
        return ProductSearchTurnResult(
            force_reply=fallback_reply,
            route="support_handoff_transition",
        )

    if is_conversational_ack(caller_text):
        ack = conversational_ack_reply(session, turn_mode=turn_mode)
        if ack:
            return ProductSearchTurnResult(force_reply=ack, route="conversational_ack")

    if not has_identifier:
        _clear_partial_isbn_collection(session)
        _log_product_search_ux_step(
            session,
            step="clarification",
            route="clarification",
            has_identifier=False,
        )
        return ProductSearchTurnResult(
            force_reply=PRODUCT_CLARIFICATION_REPLY,
            route="clarification",
        )

    _log_product_search_ux_step(
        session,
        step="match_product",
        route="catalog_resolve",
        has_identifier=True,
    )
    resolved = await _resolve_via_match_product(
        session,
        caller_text,
        turn_mode=turn_mode,
    )
    if resolved:
        return resolved

    _clear_partial_isbn_collection(session)
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
