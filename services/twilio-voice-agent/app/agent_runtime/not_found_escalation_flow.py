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
from ..email.resolver import resolve_spoken_email_address
from ..tools.isbn import extract_isbn_candidate

if TYPE_CHECKING:
    from ..config import Settings
    from .types import OrchestratorTurnContext, ToolExecutionResult
    from ..state.models import SessionState

from .workflow_contracts import (
    PRODUCT_SEARCH_WORKFLOW,
    SUPPORT_HANDOFF_WORKFLOW,
    validate_external_handler_blocked,
    workflow_guard,
)

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

_MSG_UNAVAILABLE_PRODUCT = (
    "That item isn't available to order in our store right now. "
    "I can forward your request to our support team — when we can source it, "
    "they'll reach out to you by email. May I have your name and email address?"
)

_MSG_NOT_FOUND_PRODUCT = (
    "I couldn't find that in our catalog right now. "
    "Our support team can check our warehouse and partner suppliers. "
    "When they locate it, they'll contact you by email. "
    "May I have your name and email address?"
)

_MSG_ASK_EMAIL_ONLY = "Thanks. What's your email address?"

_MSG_ASK_NAME_ONLY = "Thanks. What name should our team use for this request?"

_SUPPORT_EMAIL_RE = re.compile(
    r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$",
)
_EMAIL_CONFIRM_YES = re.compile(
    r"^\s*(yes|yeah|yep|yup|correct|that's right|that is right|right)\s*\.?\s*$",
    re.I,
)
_EMAIL_CONFIRM_LOOSE = re.compile(
    r"\b("
    r"that'?s?\s+correct|that\s+is\s+correct|that'?s?\s+true|that\s+is\s+true|"
    r"that'?s?\s+fine|that\s+is\s+fine|it'?s?\s+fine|"
    r"correct\s+email|correct\s+name|"
    r"you\s+may|sounds?\s+right|that'?s?\s+right|that'?s?\s+good|"
    r"email\s+is\s+correct|name\s+is\s+correct|absolutely"
    r")\b",
    re.I,
)
_HANDOFF_ACK_ONLY = re.compile(
    r"^\s*(okay|ok|that'?s?\s+good|sounds?\s+good|got\s+it|alright|sure|thanks|thank\s+you)\s*\.?\s*$",
    re.I,
)

PRODUCT_SEARCH_FALLBACK_HANDOFF_PROMPT = (
    "To help you better, please share your email address and name. "
    "Our support team will check availability."
)

_INSIST_PURCHASE_RE = re.compile(
    r"\b("
    r"still\s+want|really\s+need|must\s+have|need\s+to\s+(?:buy|order|get)|"
    r"want\s+to\s+(?:buy|order|purchase|get)|"
    r"please\s+(?:order|get)\s+(?:it|that|this)|"
    r"just\s+(?:order|buy|get)\s+it|"
    r"can\s+you\s+(?:order|get|find)\s+(?:it|that)|"
    r"check\s+availability|source\s+it|get\s+it\s+for\s+me|"
    r"help\s+me\s+(?:get|find|order)\s+it|"
    r"not\s+(?:those|the)\s+alternatives|don'?t\s+want\s+(?:those|the)\s+alternatives|"
    r"only\s+want\s+that|that\s+specific\s+(?:book|one|title|item)"
    r")\b",
    re.I,
)


def user_insists_on_purchase(text: str) -> bool:
    """Caller still wants the unavailable / not-found item."""
    cleaned = (text or "").strip()
    if not cleaned:
        return False
    if _INSIST_PURCHASE_RE.search(cleaned):
        return True
    from .yes_engagement import is_bare_yes

    if is_bare_yes(cleaned):
        return True
    return bool(re.match(r"^\s*(yes|yeah|yep|yup|sure|please)\s*\.?\s*$", cleaned, re.I))


def clear_product_search_fallback(session: "SessionState") -> None:
    session.product_search_fallback_pending = {}


def stage_product_search_fallback(
    session: "SessionState",
    *,
    query: str = "",
    isbn: str = "",
    escalation_eligible: bool,
) -> None:
    session.product_search_fallback_pending = {
        "query": (query or isbn or "").strip(),
        "isbn": (isbn or "").strip(),
        "escalation_eligible": bool(escalation_eligible),
    }


def try_product_search_fallback_escalation(
    session: "SessionState",
    caller_text: str,
) -> str | None:
    """
    Product_search → support_handoff transition when not-found, no similar match,
    and caller insists on purchase.
    """
    if getattr(session, "awaiting_not_found_escalation_email", False):
        return None

    pending = dict(getattr(session, "product_search_fallback_pending", None) or {})
    if not pending or not pending.get("escalation_eligible"):
        return None
    if not user_insists_on_purchase(caller_text):
        return None

    query = (pending.get("query") or pending.get("isbn") or "").strip()
    clear_product_search_fallback(session)
    return support_handoff_preparation(
        session,
        user_text=caller_text,
        query=query,
        reason="product_not_found",
        search_result={"results": [], "count": 0, "not_found": True},
        handoff_prompt=PRODUCT_SEARCH_FALLBACK_HANDOFF_PROMPT,
    )


@workflow_guard(PRODUCT_SEARCH_WORKFLOW, "support_handoff_preparation")
def support_handoff_preparation(
    session: "SessionState",
    *,
    user_text: str,
    query: str,
    reason: str = "product_not_found",
    search_result: dict[str, Any] | None = None,
    product_title: str = "",
    alternatives: list[dict[str, Any]] | None = None,
    spoken_prefix: str = "",
    handoff_prompt: str = "",
) -> str:
    """Stage support_handoff_workflow after product resolution failure."""
    from ..observability.workflow_events import (
        STEP_PRODUCT_HANDOFF_STAGED,
        emit_event,
    )

    input_type = "fallback" if reason == "product_not_found" else "unknown"
    if (query or "").strip() and extract_isbn_candidate(query):
        input_type = "isbn"
    elif (query or "").strip():
        input_type = "title"

    emit_event(
        {
            "event_type": "workflow_transition",
            "domain": "product_search",
            "step": STEP_PRODUCT_HANDOFF_STAGED,
            "input_type": input_type,
            "outcome": "escalate",
            "metadata": {
                "reason": reason,
                "query_len": len((query or "").strip()),
            },
        },
        session=session,
    )

    merged = dict(search_result or {"count": 0})
    if alternatives:
        merged["similar_products"] = [
            {
                "title": alt.get("title"),
                "variant_id": alt.get("variant_id"),
                "price": alt.get("price"),
            }
            for alt in alternatives[:3]
        ]

    begin_unavailable_product_handoff(
        session,
        user_text=user_text,
        query=query,
        reason=reason,
        search_result=merged,
        product_title=product_title,
    )
    pending = dict(getattr(session, "pending_not_found_escalation", None) or {})
    pending["email_capture_mode"] = "silent"
    session.pending_not_found_escalation = pending

    custom = (handoff_prompt or "").strip()
    if custom:
        return custom

    if reason == "product_out_of_stock":
        handoff_msg = _MSG_UNAVAILABLE_PRODUCT
    else:
        handoff_msg = _MSG_NOT_FOUND_PRODUCT
    prefix = (spoken_prefix or "").strip()
    if prefix:
        return f"{prefix.rstrip('.')}. {handoff_msg}"
    return handoff_msg


def _handoff_uses_silent_email(pending: dict[str, Any]) -> bool:
    mode = (pending.get("email_capture_mode") or "silent").strip().lower()
    return mode != "legacy"


@workflow_guard(SUPPORT_HANDOFF_WORKFLOW, "_validate_support_email")
def _validate_support_email(email: str) -> bool:
    return bool(_SUPPORT_EMAIL_RE.match((email or "").strip().lower()))


@workflow_guard(SUPPORT_HANDOFF_WORKFLOW, "_sync_support_handoff_contact")
def _sync_support_handoff_contact(
    session: "SessionState",
    pending: dict[str, Any],
    *,
    name: str = "",
    email: str = "",
    issue_summary: str = "",
) -> dict[str, str]:
    contact = dict(pending.get("support_handoff_contact") or {})
    if name.strip():
        contact["name"] = name.strip()
        pending["customer_name"] = name.strip()
        session.caller_name = name.strip()
    if email.strip():
        normalized = email.strip().lower()
        contact["email"] = normalized
        pending["customer_email"] = normalized
        session.caller_email = normalized
        pending["email_confirmed"] = True
        if _handoff_uses_silent_email(pending):
            from ..observability.workflow_events import (
                STEP_EMAIL_CAPTURED_SILENTLY,
                emit_event,
            )

            emit_event(
                {
                    "event_type": "workflow_transition",
                    "domain": "support",
                    "step": STEP_EMAIL_CAPTURED_SILENTLY,
                    "input_type": "email",
                    "outcome": "success",
                    "metadata": {
                        "has_name": bool((name or contact.get("name") or "").strip()),
                    },
                },
                session=session,
            )
    if issue_summary.strip():
        contact["issue_summary"] = issue_summary.strip()
    pending["support_handoff_contact"] = contact
    session.support_handoff_contact = contact
    return contact


async def _process_silent_support_handoff_turn(
    session: "SessionState",
    pending: dict[str, Any],
    caller_text: str,
    *,
    name: str = "",
) -> NotFoundEscalationTurnHint:
    """Capture name/email silently — never read email back over TTS."""
    if hasattr(session, "pending_email_fragments"):
        session.pending_email_fragments = []

    resolved = resolve_spoken_email_address(caller_text, session=session)
    email = (
        resolved.email
        or extract_email_from_text(caller_text)
        or ""
    ).strip().lower()

    if email and not _validate_support_email(email):
        return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_EMAIL_RETRY)

    if email or name:
        _sync_support_handoff_contact(session, pending, name=name, email=email)

    contact = dict(pending.get("support_handoff_contact") or {})
    stored_name = (contact.get("name") or pending.get("customer_name") or "").strip()
    stored_email = (contact.get("email") or pending.get("customer_email") or "").strip().lower()

    if stored_email and _validate_support_email(stored_email) and stored_name:
        stage_pending_escalation(session, pending)
        return await _finalize_handoff_send(
            session, pending, caller_text, name=stored_name,
        )

    stage_pending_escalation(session, pending)
    if stored_email and _validate_support_email(stored_email):
        return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_NAME_ONLY)
    if stored_name:
        return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_EMAIL_ONLY)
    return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_CONTACT)


def _handoff_uses_full_email(pending: dict[str, Any]) -> bool:
    return _handoff_uses_silent_email(pending)


def _handoff_email_confirmation_prompt(email: str, pending: dict[str, Any]) -> str:
    """Legacy confirmation readback — only when email_capture_mode is legacy."""
    from ..payment.payment_state_machine import confirmation_prompt, speak_confirmation_prompt

    if _handoff_uses_silent_email(pending):
        return confirmation_prompt(email, include_spelling=False)
    return speak_confirmation_prompt(email)


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
        name = m.group(1).strip()
        name = re.split(
            r"\s+and\s+(?:my\s+)?(?:email|e-mail)\b",
            name,
            maxsplit=1,
            flags=re.I,
        )[0].strip()
        return name.split(",")[0].strip()
    return ""


def _email_ready_to_confirm(email: str, raw_text: str) -> bool:
    """Block fragment emails like 64@gmail.com from skipping readback."""
    from ..email.capture import email_confidence, is_supplying_email_address

    if not email or "@" not in email:
        return False
    conf = email_confidence(email, raw_text)
    if conf == "low":
        return False
    local = email.split("@", 1)[0]
    if len(local) < 3 and conf != "high":
        return False
    if local.isdigit() and len(local) <= 3:
        return False
    return True


def _is_email_confirmation(text: str) -> bool:
    """Accept bare yes and natural confirmations — not 'my correct email is …'."""
    from ..email.capture import is_supplying_email_address
    from ..agent_runtime.yes_engagement import is_bare_yes

    cleaned = (text or "").strip()
    if not cleaned or is_supplying_email_address(text):
        return False
    if _EMAIL_CONFIRM_YES.match(cleaned):
        return True
    if _EMAIL_CONFIRM_LOOSE.search(cleaned):
        return True
    if is_bare_yes(cleaned):
        return True
    if re.match(r"^\s*(yes|yeah|yep|yup)\b", cleaned, re.I):
        if re.search(r"\b(name|email|isbn|book|order|my\s+name)\b", cleaned, re.I):
            return False
        return True
    from ..email.capture import is_email_confirmation

    return is_email_confirmation(text)


def _handoff_customer_name(pending: dict[str, Any], caller_text: str = "") -> str:
    """Name captured during this handoff — never Twilio caller-ID profile."""
    stored = (pending.get("customer_name") or "").strip()
    if stored:
        return stored
    return _extract_name_from_text(caller_text)


def _sync_handoff_name(
    session: "SessionState",
    pending: dict[str, Any],
    caller_text: str,
) -> str:
    name = _handoff_customer_name(pending, caller_text)
    if not name:
        name = _extract_name_from_text(caller_text)
    if name:
        pending["customer_name"] = name
    return name


def _handoff_email_fragments(pending: dict[str, Any]) -> list[str]:
    raw = pending.get("email_fragments")
    if isinstance(raw, list):
        return [str(f) for f in raw if str(f).strip()]
    return []


def _store_handoff_email_fragments(pending: dict[str, Any], fragments: list[str]) -> None:
    pending["email_fragments"] = [f for f in fragments if f.strip()][-6:]


@workflow_guard(SUPPORT_HANDOFF_WORKFLOW, "_finalize_handoff_send")
async def _finalize_handoff_send(
    session: "SessionState",
    pending: dict[str, Any],
    caller_text: str,
    *,
    name: str = "",
) -> NotFoundEscalationTurnHint:
    """Send staged escalation email to support after verified name + email."""
    from ..observability.workflow_events import (
        STEP_SUPPORT_HANDOFF_TRIGGERED,
        emit_event,
    )

    emit_event(
        {
            "event_type": "workflow_transition",
            "domain": "support",
            "step": STEP_SUPPORT_HANDOFF_TRIGGERED,
            "input_type": "email",
            "outcome": "escalate",
            "metadata": {
                "reason": str(pending.get("reason") or pending.get("escalation_reason") or ""),
                "has_name": bool((name or pending.get("customer_name") or "").strip()),
            },
        },
        session=session,
    )

    if pending.get("requested_value") and not pending.get("issue_title"):
        payload = ProductNotFoundEscalationPayload.from_dict(pending)
        if name:
            payload.customer_name = name
        elif (pending.get("customer_name") or "").strip():
            payload.customer_name = str(pending.get("customer_name") or "").strip()
    else:
        payload = CustomerQueryEscalationPayload.from_dict(pending)
        if name:
            payload.customer_name = name

    result = await maybe_execute_escalation(session, payload, caller_text=caller_text)
    clear_pending_escalation(session)

    if result.success:
        from .escalation_guard import reset

        reset(session)
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
        customer_phone="",
        customer_name="",
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
        customer_phone="",
        customer_name="",
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


def _clear_commerce_for_product_handoff(session: "SessionState") -> None:
    """Drop staged book state so support email capture does not fight commerce FSM."""
    session.commerce_pending_candidate = {}
    session.commerce_flow_status = "idle"
    session.awaiting_product_confirmation = False
    session.pending_isbn_buffer = ""
    session.commerce_pending_quantity = 0
    session.commerce_allow_add = False


def begin_unavailable_product_handoff(
    session: "SessionState",
    *,
    user_text: str,
    query: str,
    reason: str = "product_not_found",
    search_result: dict[str, Any] | None = None,
    product_title: str = "",
) -> str:
    """
    Stage support handoff when a catalog item is missing or not orderable.

    Returns the spoken prompt asking for name and email.
    """
    _clear_commerce_for_product_handoff(session)

    summary_parts: list[str] = []
    if product_title:
        summary_parts.append(f"Customer wants: {product_title[:120]}")
    if query and query.strip() != (product_title or "").strip():
        summary_parts.append(f"Search: {query.strip()[:120]}")
    if user_text:
        summary_parts.append(user_text.strip()[:300])

    merged_search = dict(search_result or {"count": 0, "not_found": reason == "product_not_found"})
    if reason == "product_out_of_stock":
        merged_search["out_of_stock"] = True
        if product_title:
            merged_search["title"] = product_title

    payload = build_escalation_payload(
        session,
        user_text=user_text,
        query=query or product_title,
        search_result=merged_search,
    )
    payload.reason = reason
    if summary_parts:
        payload.conversation_summary = " | ".join(p for p in summary_parts if p)
    payload.last_search_results = merged_search

    stage_pending_escalation(session, payload)
    logger.info(
        "unavailable_product_handoff_staged sid=%s reason=%s query=%r",
        (getattr(session, "call_sid", "") or "")[:6],
        reason,
        (query or product_title or "")[:40],
    )

    if reason == "product_out_of_stock":
        return _MSG_UNAVAILABLE_PRODUCT
    return _MSG_NOT_FOUND_PRODUCT


def stage_pending_escalation(
    session: "SessionState",
    payload: CustomerQueryEscalationPayload | ProductNotFoundEscalationPayload | dict[str, Any],
) -> None:
    if isinstance(payload, dict):
        data = dict(payload)
    else:
        data = payload.to_dict()
    data.setdefault("email_capture_mode", "silent")
    data.setdefault("support_handoff_contact", dict(data.get("support_handoff_contact") or {}))
    session.pending_not_found_escalation = data
    session.awaiting_not_found_escalation_email = True


def clear_pending_escalation(session: "SessionState") -> None:
    session.pending_not_found_escalation = {}
    session.awaiting_not_found_escalation_email = False


def should_clear_handoff_for_shopping(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> bool:
    """Caller is continuing to shop — drop a wrongly staged support handoff."""
    from ..tools.isbn import extract_isbn_candidate
    from .commerce_flow_state import _cart_has_confirmed_items

    text = (caller_text or "").strip()
    if not text:
        return False
    if (turn_mode or "").strip().lower() == "isbn" or extract_isbn_candidate(text):
        return True
    if re.search(
        r"\b(another book|next book|fifth book|third book|fourth book|"
        r"need (?:a |another )?book|want (?:a |another )?book|buy|order|isbn)\b",
        text,
        re.I,
    ):
        return _cart_has_confirmed_items(session) or bool(extract_isbn_candidate(text))
    return False


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
    validate_external_handler_blocked("try_escalate_unresolved_query")
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

    from .escalation_guard import LOOP_TERMINAL_REPLY

    if getattr(session, "escalation_loop_terminal", False):
        clear_pending_escalation(session)
        from .escalation_guard import reset

        reset(session)
        return NotFoundEscalationTurnHint(force_reply=LOOP_TERMINAL_REPLY)

    if should_clear_handoff_for_shopping(session, caller_text, turn_mode=turn_mode):
        clear_pending_escalation(session)
        return NotFoundEscalationTurnHint()

    pending = dict(getattr(session, "pending_not_found_escalation", None) or {})
    if not pending:
        session.awaiting_not_found_escalation_email = False
        return NotFoundEscalationTurnHint()

    name = _sync_handoff_name(session, pending, caller_text)

    if _handoff_uses_silent_email(pending):
        return await _process_silent_support_handoff_turn(
            session, pending, caller_text, name=name,
        )

    if pending.get("awaiting_email_confirmation"):
        staged_email = (pending.get("staging_email") or "").strip().lower()
        from ..email.capture import is_email_correction

        if is_email_correction(caller_text):
            pending.pop("awaiting_email_confirmation", None)
            pending.pop("staging_email", None)
            stage_pending_escalation(session, pending)
            return NotFoundEscalationTurnHint(
                force_reply="No problem — please say your full email address slowly.",
            )

        if _is_email_confirmation(caller_text):
            if not staged_email or "@" not in staged_email:
                pending.pop("awaiting_email_confirmation", None)
                pending.pop("staging_email", None)
                stage_pending_escalation(session, pending)
                return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_EMAIL_ONLY)
            pending["customer_email"] = staged_email
            pending["email_confirmed"] = True
            pending.pop("awaiting_email_confirmation", None)
            pending.pop("staging_email", None)
            pending.pop("email_fragments", None)
            session.caller_email = staged_email
            if name:
                pending["customer_name"] = name
            stage_pending_escalation(session, pending)
            return await _finalize_handoff_send(
                session, pending, caller_text, name=name,
            )

        if is_email_spell_request(caller_text) or is_repeat_email_request(caller_text):
            if staged_email:
                return NotFoundEscalationTurnHint(
                    force_reply=_handoff_email_confirmation_prompt(staged_email, pending),
                )

        fragments = _handoff_email_fragments(pending)
        if hasattr(session, "pending_email_fragments"):
            session.pending_email_fragments = fragments
        corrected = resolve_spoken_email_address(caller_text, session=session).email
        if corrected and corrected != staged_email:
            pending["staging_email"] = corrected
            _store_handoff_email_fragments(pending, [])
            stage_pending_escalation(session, pending)
            return NotFoundEscalationTurnHint(
                force_reply=_handoff_email_confirmation_prompt(corrected, pending),
            )
        if staged_email:
            return NotFoundEscalationTurnHint(
                force_reply=_handoff_email_confirmation_prompt(staged_email, pending),
            )
        if _handoff_uses_full_email(pending):
            return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_EMAIL_RETRY)
        return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_EMAIL_RETRY)

    if not pending.get("email_confirmed"):
        if _handoff_uses_full_email(pending):
            resolved = resolve_spoken_email_address(caller_text, session=session)
            email = (resolved.email or extract_email_from_text(caller_text) or "").strip().lower()
            if not email or "@" not in email:
                if name and not _HANDOFF_ACK_ONLY.match(caller_text or ""):
                    return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_EMAIL_ONLY)
                return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_CONTACT)
            pending["staging_email"] = email
            pending["awaiting_email_confirmation"] = True
            stage_pending_escalation(session, pending)
            return NotFoundEscalationTurnHint(
                force_reply=_handoff_email_confirmation_prompt(email, pending),
            )

        fragments = _handoff_email_fragments(pending)
        if hasattr(session, "pending_email_fragments"):
            session.pending_email_fragments = fragments
        resolved = resolve_spoken_email_address(caller_text, session=session)
        email = (resolved.email or "").strip().lower()
        if not email or "@" not in email:
            partial = (caller_text or "").strip()
            if partial and not _is_email_confirmation(partial):
                fragments = fragments + [partial]
                _store_handoff_email_fragments(pending, fragments)
                stage_pending_escalation(session, pending)
            if fragments:
                return NotFoundEscalationTurnHint(
                    force_reply=_MSG_ASK_EMAIL_RETRY,
                )
            if name and not _HANDOFF_ACK_ONLY.match(caller_text or ""):
                stage_pending_escalation(session, pending)
                return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_EMAIL_ONLY)
            if _HANDOFF_ACK_ONLY.match(caller_text or ""):
                return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_CONTACT)
            return NotFoundEscalationTurnHint(force_reply=_MSG_ASK_CONTACT)

        if hasattr(session, "pending_email_fragments"):
            session.pending_email_fragments = []
        if not _email_ready_to_confirm(email, caller_text):
            pending["email_fragments"] = _handoff_email_fragments(pending) + [caller_text.strip()]
            stage_pending_escalation(session, pending)
            return NotFoundEscalationTurnHint(
                force_reply=_MSG_ASK_EMAIL_RETRY,
            )
        pending["staging_email"] = email
        pending["awaiting_email_confirmation"] = True
        pending.pop("email_fragments", None)
        stage_pending_escalation(session, pending)
        return NotFoundEscalationTurnHint(
            force_reply=_handoff_email_confirmation_prompt(email, pending),
        )

    return await _finalize_handoff_send(session, pending, caller_text, name=name)


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
    validate_external_handler_blocked("handle_search_not_found_results")
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
