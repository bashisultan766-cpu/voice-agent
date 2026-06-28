"""
Unified customer-query escalation — order not found, product not found, API misses.

Stages pending escalation on session, collects email, LLM-summarizes conversation,
emails backend team (jessica@sureshotbooks.com via SUPPORT_EMAIL).
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Optional, TYPE_CHECKING

from ..escalation.customer_query_escalation import create_customer_query_escalation
from ..escalation.models import CustomerQueryEscalationPayload
from ..payment.payment_state_machine import extract_email_from_text

if TYPE_CHECKING:
    from ..orchestrator.types import ToolExecutionResult
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_MSG_ASK_EMAIL = (
    "I couldn't find that in our system right now. "
    "I can forward your full request to our backend team so they can help manually. "
    "What email should they use to reach you?"
)

_MSG_SUCCESS = (
    "I've sent your request to our backend team. "
    "They'll review everything we discussed and contact you by email."
)


@dataclass
class CustomerQueryEscalationTurnHint:
    force_reply: Optional[str] = None
    skip_compose: bool = False
    extra_tool_result: Optional["ToolExecutionResult"] = None


def _resolved_customer_email(session: "SessionState") -> str:
    for attr in ("confirmed_email", "caller_email"):
        val = (getattr(session, attr, "") or "").strip().lower()
        if val and "@" in val:
            return val
    if getattr(session, "payment_email_confirmed", False):
        pending = (getattr(session, "pending_payment_email", "") or "").strip().lower()
        if pending and "@" in pending:
            return pending
    return ""


def build_customer_query_payload(
    session: "SessionState",
    *,
    query_type: str,
    issue_title: str,
    issue_detail: str,
    api_context: dict[str, Any] | None = None,
    customer_email: str = "",
    reason: str = "unresolved_customer_query",
) -> CustomerQueryEscalationPayload:
    email = (customer_email or _resolved_customer_email(session)).strip().lower()
    return CustomerQueryEscalationPayload(
        session_id=getattr(session, "session_id", "") or getattr(session, "call_sid", ""),
        call_sid=getattr(session, "call_sid", "") or "",
        customer_phone=getattr(session, "from_number", "") or "",
        customer_name=getattr(session, "caller_name", "") or "",
        customer_email=email,
        query_type=query_type,
        issue_title=issue_title,
        issue_detail=issue_detail,
        api_context=dict(api_context or {}),
        reason=reason,
    )


def stage_pending_escalation(
    session: "SessionState",
    payload: CustomerQueryEscalationPayload,
) -> None:
    session.pending_not_found_escalation = payload.to_dict()
    session.awaiting_not_found_escalation_email = True


def clear_pending_escalation(session: "SessionState") -> None:
    session.pending_not_found_escalation = {}
    session.awaiting_not_found_escalation_email = False


def _tool_execution_result(tool: str, parsed: dict[str, Any], *, raw: str = "") -> "ToolExecutionResult":
    from ..orchestrator.types import ToolExecutionResult

    return ToolExecutionResult(
        tool=tool,
        success=bool(parsed.get("success")),
        result=parsed,
        raw_json=raw or json.dumps(parsed),
    )


async def maybe_execute_escalation(
    session: "SessionState",
    payload: CustomerQueryEscalationPayload,
    *,
    caller_text: str = "",
) -> "ToolExecutionResult":
    raw = await create_customer_query_escalation(
        payload, session=session, caller_text=caller_text,
    )
    parsed = json.loads(raw)
    return _tool_execution_result("create_customer_query_escalation", parsed, raw=raw)


async def try_escalate_unresolved_query(
    session: "SessionState",
    *,
    caller_text: str = "",
    query_type: str = "general",
    issue_title: str = "",
    issue_detail: str = "",
    api_context: dict[str, Any] | None = None,
    reason: str = "unresolved_customer_query",
) -> CustomerQueryEscalationTurnHint:
    """
    Stage or immediately send a backend escalation for an unresolved customer query.
    """
    email = _resolved_customer_email(session)
    payload = build_customer_query_payload(
        session,
        query_type=query_type,
        issue_title=issue_title,
        issue_detail=issue_detail,
        api_context=api_context,
        customer_email=email,
        reason=reason,
    )

    idem_key = payload.idempotency_key()
    if idem_key in list(getattr(session, "not_found_escalation_sent_keys", None) or []):
        return CustomerQueryEscalationTurnHint(force_reply=_MSG_SUCCESS)

    if not email:
        stage_pending_escalation(session, payload)
        return CustomerQueryEscalationTurnHint(force_reply=_MSG_ASK_EMAIL)

    result = await maybe_execute_escalation(session, payload, caller_text=caller_text)
    if result.success:
        clear_pending_escalation(session)
        return CustomerQueryEscalationTurnHint(
            force_reply=result.result.get("customer_message") or _MSG_SUCCESS,
            extra_tool_result=result,
        )

    err = str(result.result.get("error_code") or "")
    if err == "missing_customer_email":
        stage_pending_escalation(session, payload)
        return CustomerQueryEscalationTurnHint(force_reply=_MSG_ASK_EMAIL)

    return CustomerQueryEscalationTurnHint(
        force_reply=str(
            result.result.get("customer_message")
            or "I had trouble forwarding that to our team. Please try again."
        ),
        extra_tool_result=result,
    )


async def process_customer_query_escalation_turn(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> CustomerQueryEscalationTurnHint:
    """Handle email capture for a staged customer-query escalation."""
    if not getattr(session, "awaiting_not_found_escalation_email", False):
        return CustomerQueryEscalationTurnHint()

    pending = dict(getattr(session, "pending_not_found_escalation", None) or {})
    if not pending:
        session.awaiting_not_found_escalation_email = False
        return CustomerQueryEscalationTurnHint()

    email = _resolved_customer_email(session)
    if not email:
        email = (extract_email_from_text(caller_text, session) or "").strip().lower()

    if not email or "@" not in email:
        return CustomerQueryEscalationTurnHint(force_reply=_MSG_ASK_EMAIL)

    session.caller_email = email
    pending["customer_email"] = email

    # Support legacy product-not-found pending payloads
    if pending.get("requested_value") and not pending.get("issue_title"):
        from ..escalation.customer_query_escalation import product_payload_to_customer_query
        from ..escalation.models import ProductNotFoundEscalationPayload

        legacy = ProductNotFoundEscalationPayload.from_dict(pending)
        legacy.customer_email = email
        payload = product_payload_to_customer_query(legacy, session=session, caller_text=caller_text)
    else:
        payload = CustomerQueryEscalationPayload.from_dict(pending)

    result = await maybe_execute_escalation(session, payload, caller_text=caller_text)
    clear_pending_escalation(session)

    if result.success:
        return CustomerQueryEscalationTurnHint(
            force_reply=result.result.get("customer_message") or _MSG_SUCCESS,
            extra_tool_result=result,
        )

    return CustomerQueryEscalationTurnHint(
        force_reply=str(
            result.result.get("customer_message")
            or "I had trouble forwarding that to our team. Please try again."
        ),
        extra_tool_result=result,
    )
