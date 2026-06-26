"""
Product-not-found escalation flow — email capture and support notification.

Separate from payment email FSM; does not mutate payment_flow_status.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Optional, TYPE_CHECKING

from ..escalation.models import ProductNotFoundEscalationPayload
from ..escalation.product_not_found_escalation import create_product_not_found_escalation
from ..payment.payment_state_machine import extract_email_from_text
from ..tools.isbn import extract_isbn_candidate

if TYPE_CHECKING:
    from ..config import Settings
    from ..orchestrator.types import OrchestratorTurnContext, ToolExecutionResult
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_MSG_ASK_EMAIL = (
    "That item is not showing as available right now. "
    "I can forward this to our team to check manually. "
    "What email should they use to contact you?"
)

_MSG_SUCCESS = (
    "That item is not showing as available right now. "
    "I'll forward this to our team. If we can source it, they'll contact you by email."
)

_ISBN = re.compile(r"\b(?:97[89]\d{10}|\d{9}[\dXx]|\d{13})\b")
_NEWSPAPER = re.compile(r"\bnewspaper\b", re.I)
_MAGAZINE = re.compile(r"\bmagazine\b", re.I)
_AUTHOR = re.compile(r"\bby\s+([A-Za-z][\w\s\-\.']{1,40})", re.I)
_QTY = re.compile(r"\b(\d{1,2})\s+(?:copies|copy|books?)\b", re.I)


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
    for attr in (
        "confirmed_email",
        "caller_email",
    ):
        val = (getattr(session, attr, "") or "").strip().lower()
        if val and "@" in val:
            return val
    if getattr(session, "payment_email_confirmed", False):
        pending = (getattr(session, "pending_payment_email", "") or "").strip().lower()
        if pending and "@" in pending:
            return pending
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


def _tool_execution_result(tool: str, parsed: dict[str, Any], *, raw: str = "") -> "ToolExecutionResult":
    from ..orchestrator.types import ToolExecutionResult

    success = bool(parsed.get("success"))
    return ToolExecutionResult(
        tool=tool,
        success=success,
        result=parsed,
        raw_json=raw or json.dumps(parsed),
    )


async def maybe_execute_escalation(
    session: "SessionState",
    payload: ProductNotFoundEscalationPayload,
) -> "ToolExecutionResult":
    raw = await create_product_not_found_escalation(payload, session=session)
    parsed = json.loads(raw)
    return _tool_execution_result("create_product_not_found_escalation", parsed, raw=raw)


def stage_pending_escalation(
    session: "SessionState",
    payload: ProductNotFoundEscalationPayload,
) -> None:
    session.pending_not_found_escalation = payload.to_dict()
    session.awaiting_not_found_escalation_email = True


def clear_pending_escalation(session: "SessionState") -> None:
    session.pending_not_found_escalation = {}
    session.awaiting_not_found_escalation_email = False


async def process_not_found_escalation_turn(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> NotFoundEscalationTurnHint:
    """Handle email capture for a staged not-found escalation."""
    if not getattr(session, "awaiting_not_found_escalation_email", False):
        return NotFoundEscalationTurnHint()

    pending = dict(getattr(session, "pending_not_found_escalation", None) or {})
    if not pending:
        session.awaiting_not_found_escalation_email = False
        return NotFoundEscalationTurnHint()

    email = _resolved_customer_email(session)
    if not email:
        email = (extract_email_from_text(caller_text, session) or "").strip().lower()

    if not email or "@" not in email:
        return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_EMAIL)

    pending["customer_email"] = email
    payload = ProductNotFoundEscalationPayload.from_dict(pending)
    result = await maybe_execute_escalation(session, payload)
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

    # If any parallel search found a product, do not escalate.
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
        return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_EMAIL)

    result = await maybe_execute_escalation(session, payload)
    if result.success:
        return NotFoundEscalationTurnHint(
            force_reply=result.result.get("customer_message") or _MSG_SUCCESS,
            extra_tool_result=result,
        )

    return NotFoundEscalationTurnHint(
        force_reply=str(result.result.get("customer_message") or _MSG_ASK_EMAIL),
        extra_tool_result=result,
    )
