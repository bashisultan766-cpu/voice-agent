"""
Support handoff flow — product/order/refund misses, email capture, support notification.

Separate from payment email FSM; does not mutate payment_flow_status.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Optional, TYPE_CHECKING

from ..escalation.models import CustomerQueryEscalationPayload, ProductNotFoundEscalationPayload
from ..escalation.support_handoff import send_support_handoff
from ..payment.payment_state_machine import extract_email_from_text
from ..tools.isbn import extract_isbn_candidate

if TYPE_CHECKING:
    from ..config import Settings
    from ..orchestrator.types import OrchestratorTurnContext, ToolExecutionResult
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_MSG_ASK_CONTACT = (
    "I'm not seeing that information available right now. "
    "I can have our support team follow up with you by email. "
    "May I have your name and email?"
)

_MSG_SUCCESS = (
    "I've forwarded your request to our support team. "
    "They'll review everything we discussed and contact you by email."
)

_ISBN = re.compile(r"\b(?:97[89]\d{10}|\d{9}[\dXx]|\d{13})\b")
_NEWSPAPER = re.compile(r"\bnewspaper\b", re.I)
_MAGAZINE = re.compile(r"\bmagazine\b", re.I)
_AUTHOR = re.compile(r"\bby\s+([A-Za-z][\w\s\-\.']{1,40})", re.I)
_QTY = re.compile(r"\b(\d{1,2})\s+(?:copies|copy|books?)\b", re.I)
_NAME_BEFORE_EMAIL = re.compile(
    r"(?:my name is|this is|i am|i'm)\s+([A-Za-z][\w\s\-\.']{1,40})",
    re.I,
)


@dataclass
class NotFoundEscalationTurnHint:
    force_reply: Optional[str] = None
    skip_compose: bool = False
    extra_tool_result: Optional["ToolExecutionResult"] = None


def is_search_not_found(result: dict[str, Any]) -> bool:
    if not result or result.get("needs_more_digits"):
        return False
    if result.get("error"):
        return False
    if result.get("not_found") is True:
        return True
    results = result.get("results") or []
    count = result.get("count")
    if count is None:
        count = len(results) if isinstance(results, list) else 0
    return int(count or 0) == 0 and not results


def infer_requested_type(user_text: str, query: str) -> str:
    text = f"{user_text} {query}".lower()
    if extract_isbn_candidate(query) or _ISBN.search(query):
        return "isbn"
    if _NEWSPAPER.search(text):
        return "newspaper"
    if _MAGAZINE.search(text):
        return "magazine"
    if _AUTHOR.search(user_text or ""):
        return "author"
    if (query or "").strip():
        return "title"
    return "unknown"


def _extract_quantity(user_text: str) -> Optional[int]:
    m = _QTY.search(user_text or "")
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            return None
    return None


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


def _extract_name_from_text(text: str) -> str:
    m = _NAME_BEFORE_EMAIL.search(text or "")
    if m:
        return m.group(1).strip()
    return ""


def build_escalation_payload(
    session: "SessionState",
    *,
    user_text: str,
    query: str,
    search_result: dict[str, Any],
    customer_email: str = "",
) -> ProductNotFoundEscalationPayload:
    email = (customer_email or _resolved_customer_email(session)).strip().lower()
    return ProductNotFoundEscalationPayload(
        session_id=getattr(session, "session_id", "") or getattr(session, "call_sid", ""),
        call_sid=getattr(session, "call_sid", "") or "",
        customer_phone=getattr(session, "from_number", "") or "",
        customer_name=getattr(session, "caller_name", "") or "",
        customer_email=email,
        requested_type=infer_requested_type(user_text, query),  # type: ignore[arg-type]
        requested_value=(query or user_text or "").strip()[:500],
        quantity=_extract_quantity(user_text),
        facility_name=getattr(session, "last_facility_name", "") or "",
        conversation_summary=(user_text or "")[:500],
        last_search_results={
            "query": query,
            "not_found": True,
            "count": search_result.get("count", 0),
        },
        reason="product_not_found",
    )


def build_support_handoff_payload(
    session: "SessionState",
    *,
    query_type: str,
    issue_title: str,
    issue_detail: str,
    api_context: dict[str, Any] | None = None,
    customer_email: str = "",
    reason: str = "data_unavailable",
    what_customer_asked: str = "",
    what_agent_tried: str = "",
    tool_api_result: dict[str, Any] | None = None,
    recommended_next_action: str = "",
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
        what_customer_asked=what_customer_asked,
        what_agent_tried=what_agent_tried,
        tool_api_result=dict(tool_api_result or api_context or {}),
        reason_for_handoff=reason,
        recommended_next_action=recommended_next_action,
        api_context=dict(api_context or {}),
        reason=reason,
    )


def stage_pending_escalation(
    session: "SessionState",
    payload: CustomerQueryEscalationPayload | ProductNotFoundEscalationPayload,
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
    payload: CustomerQueryEscalationPayload | ProductNotFoundEscalationPayload,
    *,
    caller_text: str = "",
) -> "ToolExecutionResult":
    if isinstance(payload, ProductNotFoundEscalationPayload):
        from ..escalation.support_handoff import product_payload_to_support_handoff

        handoff = product_payload_to_support_handoff(payload, session=session, caller_text=caller_text)
    else:
        handoff = payload

    raw = await send_support_handoff(handoff, session=session, caller_text=caller_text)
    parsed = json.loads(raw)
    tool_name = (
        "create_product_not_found_escalation"
        if isinstance(payload, ProductNotFoundEscalationPayload)
        else "send_support_handoff"
    )
    return _tool_execution_result(tool_name, parsed, raw=raw)


async def try_escalate_unresolved_query(
    session: "SessionState",
    *,
    caller_text: str = "",
    query_type: str = "general",
    issue_title: str = "",
    issue_detail: str = "",
    api_context: dict[str, Any] | None = None,
    reason: str = "unresolved_customer_query",
    what_agent_tried: str = "",
    recommended_next_action: str = "",
) -> NotFoundEscalationTurnHint:
    """Stage or immediately send support handoff for an unresolved customer query."""
    email = _resolved_customer_email(session)
    payload = build_support_handoff_payload(
        session,
        query_type=query_type,
        issue_title=issue_title,
        issue_detail=issue_detail,
        api_context=api_context,
        customer_email=email,
        reason=reason,
        what_customer_asked=caller_text,
        what_agent_tried=what_agent_tried or "Automated Shopify/catalog/order lookup",
        tool_api_result=api_context,
        recommended_next_action=recommended_next_action,
    )

    idem_key = payload.idempotency_key()
    if idem_key in list(getattr(session, "not_found_escalation_sent_keys", None) or []):
        return NotFoundEscalationTurnHint(force_reply=_MSG_SUCCESS)

    if not email:
        stage_pending_escalation(session, payload)
        return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_CONTACT)

    result = await maybe_execute_escalation(session, payload, caller_text=caller_text)
    if result.success:
        clear_pending_escalation(session)
        return NotFoundEscalationTurnHint(
            force_reply=result.result.get("customer_message") or _MSG_SUCCESS,
            extra_tool_result=result,
        )

    err = str(result.result.get("error_code") or "")
    if err == "missing_customer_email":
        stage_pending_escalation(session, payload)
        return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_CONTACT)

    return NotFoundEscalationTurnHint(
        force_reply=str(
            result.result.get("customer_message")
            or "I had trouble forwarding that to our team. Please try again."
        ),
        extra_tool_result=result,
    )


async def process_not_found_escalation_turn(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> NotFoundEscalationTurnHint:
    """Handle name/email capture for a staged support handoff."""
    if not getattr(session, "awaiting_not_found_escalation_email", False):
        return NotFoundEscalationTurnHint()

    pending = dict(getattr(session, "pending_not_found_escalation", None) or {})
    if not pending:
        session.awaiting_not_found_escalation_email = False
        return NotFoundEscalationTurnHint()

    name = (getattr(session, "caller_name", "") or "").strip()
    if not name:
        name = _extract_name_from_text(caller_text)
        if name:
            session.caller_name = name

    email = _resolved_customer_email(session)
    if not email:
        email = (extract_email_from_text(caller_text, session) or "").strip().lower()

    if not email or "@" not in email:
        return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_CONTACT)

    session.caller_email = email
    pending["customer_email"] = email
    if name:
        pending["customer_name"] = name

    if pending.get("requested_value") and not pending.get("issue_title"):
        payload = ProductNotFoundEscalationPayload.from_dict(pending)
        payload.customer_email = email
        if name:
            payload.customer_name = name
    else:
        payload = CustomerQueryEscalationPayload.from_dict(pending)

    result = await maybe_execute_escalation(session, payload, caller_text=caller_text)
    clear_pending_escalation(session)

    if result.success:
        return NotFoundEscalationTurnHint(
            force_reply=result.result.get("customer_message") or _MSG_SUCCESS,
            extra_tool_result=result,
        )

    return NotFoundEscalationTurnHint(
        force_reply=str(
            result.result.get("customer_message")
            or "I had trouble forwarding that to our team. Please try again."
        ),
        extra_tool_result=result,
    )


async def handle_search_not_found_results(
    session: "SessionState",
    ctx: "OrchestratorTurnContext",
    *,
    settings: Optional["Settings"] = None,
) -> NotFoundEscalationTurnHint:
    """
    After Shopify search confirms not_found, stage or execute escalation.

    Only runs for product_search intent with a not_found search_products result.
    """
    supervisor = ctx.supervisor
    if not supervisor or supervisor.intent != "product_search":
        return NotFoundEscalationTurnHint()

    search_hits: list[tuple[str, dict[str, Any]]] = []
    for tr in ctx.tool_results:
        if tr.tool != "search_products":
            continue
        if is_search_not_found(tr.result):
            query = ""
            if ctx.planner:
                for step in ctx.planner.steps:
                    if step.tool == "search_products":
                        query = str((step.args or {}).get("query") or "")
                        break
            if not query:
                query = (ctx.user_text or "").strip()
            search_hits.append((query, tr.result))

    if not search_hits:
        return NotFoundEscalationTurnHint()

    for tr in ctx.tool_results:
        if tr.tool == "search_products" and not is_search_not_found(tr.result):
            results = tr.result.get("results") or []
            if results:
                return NotFoundEscalationTurnHint()

    query, search_result = search_hits[0]
    email = _resolved_customer_email(session)
    payload = build_escalation_payload(
        session,
        user_text=ctx.user_text,
        query=query,
        search_result=search_result,
        customer_email=email,
    )

    idem_key = payload.idempotency_key()
    if idem_key in list(getattr(session, "not_found_escalation_sent_keys", None) or []):
        return NotFoundEscalationTurnHint(force_reply=_MSG_SUCCESS)

    if not email:
        stage_pending_escalation(session, payload)
        return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_CONTACT)

    result = await maybe_execute_escalation(session, payload, caller_text=ctx.user_text or "")
    if result.success:
        return NotFoundEscalationTurnHint(
            force_reply=result.result.get("customer_message") or _MSG_SUCCESS,
            extra_tool_result=result,
        )

    return NotFoundEscalationTurnHint(
        force_reply=str(result.result.get("customer_message") or _MSG_ASK_CONTACT),
        extra_tool_result=result,
    )
