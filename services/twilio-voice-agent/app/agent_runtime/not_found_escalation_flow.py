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
from ..payment.payment_state_machine import extract_email_from_text, speak_confirmation_prompt
from ..email.capture import is_email_spell_request, is_repeat_email_request
from ..email.resolver import fragment_capture_prompt, resolve_spoken_email_address
from ..tools.isbn import extract_isbn_candidate

if TYPE_CHECKING:
    from ..config import Settings
    from .types import OrchestratorTurnContext, ToolExecutionResult
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_MSG_ASK_CONTACT = (
    "I can forward your message to our customer support team, and they'll follow up with you by email. "
    "May I have your name and email address?"
)

_MSG_ASK_EMAIL_RETRY = (
    "Please say your full email in one sentence — for example, john smith at gmail dot com."
)

_MSG_SUCCESS = (
    "I've forwarded your message to our support team. They'll contact you by email — "
    "you can hang up whenever you're ready."
)

_EMAIL_CONFIRM_YES = re.compile(
    r"^\s*(yes|yeah|yep|yup|correct|that's right|that is right|right)\s*\.?\s*$",
    re.I,
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
    """Email confirmed during support handoff capture — never profile email alone."""
    pending = dict(getattr(session, "pending_not_found_escalation", None) or {})
    if pending.get("email_confirmed"):
        email = (pending.get("customer_email") or "").strip().lower()
        if email and "@" in email:
            return email
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
    payload: CustomerQueryEscalationPayload | ProductNotFoundEscalationPayload | dict[str, Any],
) -> None:
    if isinstance(payload, dict):
        session.pending_not_found_escalation = dict(payload)
    else:
        session.pending_not_found_escalation = payload.to_dict()
    session.awaiting_not_found_escalation_email = True


def clear_pending_escalation(session: "SessionState") -> None:
    session.pending_not_found_escalation = {}
    session.awaiting_not_found_escalation_email = False


def _tool_execution_result(tool: str, parsed: dict[str, Any], *, raw: str = "") -> "ToolExecutionResult":
    from .types import ToolExecutionResult

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


async def try_cancellation_support_handoff(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> NotFoundEscalationTurnHint:
    """Stage support handoff for order cancellation — name + confirmed email required."""
    if getattr(session, "awaiting_not_found_escalation_email", False):
        return NotFoundEscalationTurnHint()

    from .order_flow_state import extract_order_number

    order_num = (
        extract_order_number(caller_text, session, turn_mode=turn_mode)
        or (getattr(session, "last_order_number", "") or "").strip()
    )
    title = "Order cancellation request"
    if order_num:
        title = f"Order cancellation request — order {order_num}"
    detail = (caller_text or "").strip()[:500]

    return await try_escalate_unresolved_query(
        session,
        caller_text=caller_text,
        query_type="cancellation",
        issue_title=title,
        issue_detail=detail,
        reason="order_cancellation_request",
        what_agent_tried="Recorded cancellation request for support team",
        recommended_next_action="Process order cancellation and confirm with customer by email.",
    )


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

    stage_pending_escalation(session, payload)
    return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_CONTACT)


async def process_not_found_escalation_turn(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> NotFoundEscalationTurnHint:
    """Handle name/email capture and confirmation for a staged support handoff."""
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

    if pending.get("awaiting_email_confirmation"):
        staged_email = (pending.get("staging_email") or "").strip().lower()
        if _EMAIL_CONFIRM_YES.match(caller_text or ""):
            if not staged_email or "@" not in staged_email:
                pending.pop("awaiting_email_confirmation", None)
                pending.pop("staging_email", None)
                stage_pending_escalation(session, pending)
                return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_CONTACT)
            pending["customer_email"] = staged_email
            pending["email_confirmed"] = True
            pending.pop("awaiting_email_confirmation", None)
            pending.pop("staging_email", None)
            session.caller_email = staged_email
            if name:
                pending["customer_name"] = name
            stage_pending_escalation(session, pending)
        else:
            if is_email_spell_request(caller_text) or is_repeat_email_request(caller_text):
                if staged_email:
                    return NotFoundEscalationTurnHint(
                        force_reply=speak_confirmation_prompt(staged_email),
                    )
            corrected = resolve_spoken_email_address(caller_text, session=session).email
            if corrected and corrected != staged_email:
                pending["staging_email"] = corrected
                stage_pending_escalation(session, pending)
                return NotFoundEscalationTurnHint(
                    force_reply=speak_confirmation_prompt(corrected),
                )
            if staged_email:
                return NotFoundEscalationTurnHint(
                    force_reply=speak_confirmation_prompt(staged_email),
                )
            return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_EMAIL_RETRY)

    if not pending.get("email_confirmed"):
        resolved = resolve_spoken_email_address(caller_text, session=session)
        email = (resolved.email or "").strip().lower()
        if not email or "@" not in email:
            fragments = list(getattr(session, "pending_email_fragments", None) or [])
            if fragments:
                return NotFoundEscalationTurnHint(
                    force_reply=fragment_capture_prompt(len(fragments)),
                )
            return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_CONTACT)

        if hasattr(session, "pending_email_fragments"):
            session.pending_email_fragments = []
        pending["staging_email"] = email
        pending["awaiting_email_confirmation"] = True
        stage_pending_escalation(session, pending)
        return NotFoundEscalationTurnHint(force_reply=speak_confirmation_prompt(email))

    if pending.get("requested_value") and not pending.get("issue_title"):
        payload = ProductNotFoundEscalationPayload.from_dict(pending)
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

    stage_pending_escalation(session, payload)
    return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_CONTACT)
