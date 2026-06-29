"""
Canonical voice-agent support handoff — LLM summary + email to support team.

Single escalation path for missing product/order/refund/tracking/API data.
Destination: SUPPORT_EMAIL, JESSICA_EMAIL, or CUSTOMER_SERVICE_EMAIL (env).
"""
from __future__ import annotations

import json
import logging
import re
import time
import uuid
from typing import Any, Optional, TYPE_CHECKING

import httpx

from ..config import get_settings
from .models import CustomerQueryEscalationPayload, ProductNotFoundEscalationPayload
from .product_not_found_escalation import (
    _get_existing_record,
    _mask_email,
    _mask_phone,
    _save_record,
    resolve_escalation_from_email,
    resolve_support_email,
)

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_CUSTOMER_MESSAGE_SUCCESS = (
    "I've forwarded your message to our support team. They'll contact you by email — "
    "you can hang up whenever you're ready."
)

_CUSTOMER_MESSAGE_ASK_CONTACT = (
    "I can forward your message to our customer support team, and they'll follow up with you by email. "
    "May I have your name and email address?"
)

_SECRET_KEY_RE = re.compile(
    r"(token|api[_-]?key|password|secret|authorization|cvv|cvc|card[_-]?number)",
    re.I,
)
_CARD_FULL_RE = re.compile(r"\b\d{13,19}\b")


def _issue_type_label(query_type: str) -> str:
    mapping = {
        "order": "Order Not Found",
        "product": "Product Not Found",
        "refund": "Refund Unavailable",
        "facility": "Facility Policy Unknown",
        "shipping": "Tracking Unavailable",
        "isbn": "ISBN Not Found",
        "title": "Title Not Found",
        "author": "Author Not Found",
        "newspaper": "Newspaper Not Found",
        "magazine": "Magazine Not Found",
        "shopify_api_error": "Shopify API Error",
        "tool_timeout": "Tool Timeout",
        "cancellation": "Order Cancellation",
        "complaint": "Customer Complaint",
        "general": "General Support",
        "unknown": "General Support",
    }
    return mapping.get((query_type or "").strip().lower(), query_type or "General Support")


def _sanitize_api_context(ctx: dict[str, Any] | None) -> dict[str, Any]:
    """Strip secrets and oversized raw payloads from support email context."""
    if not ctx:
        return {}
    out: dict[str, Any] = {}
    for key, val in ctx.items():
        key_l = str(key).lower()
        if _SECRET_KEY_RE.search(key_l):
            out[key] = "[redacted]"
            continue
        if isinstance(val, str):
            if _CARD_FULL_RE.search(val):
                out[key] = "[redacted card]"
            else:
                out[key] = val[:800]
        elif isinstance(val, (int, float, bool)) or val is None:
            out[key] = val
        elif isinstance(val, dict):
            out[key] = _sanitize_api_context(val)
        elif isinstance(val, list):
            out[key] = [
                _sanitize_api_context(v) if isinstance(v, dict) else str(v)[:200]
                for v in val[:20]
            ]
        else:
            out[key] = str(val)[:500]
    return out


def product_payload_to_support_handoff(
    payload: ProductNotFoundEscalationPayload,
    *,
    session: Optional["SessionState"] = None,
    caller_text: str = "",
) -> CustomerQueryEscalationPayload:
    query_type = payload.requested_type if payload.requested_type != "unknown" else "product"
    title = f"Product not found — {payload.requested_type}: {payload.requested_value[:80]}"
    detail = (
        f"Customer searched for {payload.requested_type} "
        f"'{payload.requested_value}'. Shopify/catalog returned no match."
    )
    if payload.quantity:
        detail += f" Requested quantity: {payload.quantity}."
    if payload.facility_name:
        detail += f" Facility: {payload.facility_name}."
    return CustomerQueryEscalationPayload(
        session_id=payload.session_id,
        call_sid=payload.call_sid,
        customer_phone=payload.customer_phone,
        customer_name=payload.customer_name,
        customer_email=payload.customer_email,
        query_type=query_type,
        issue_title=title,
        issue_detail=detail,
        what_customer_asked=(caller_text or payload.conversation_summary or "")[:500],
        what_agent_tried="Shopify catalog search (search_products / ISBN lookup)",
        tool_api_result=_sanitize_api_context(payload.last_search_results),
        reason_for_handoff=payload.reason or "product_not_found",
        recommended_next_action="Source the requested item manually and email the customer.",
        conversation_summary=payload.conversation_summary,
        api_context={
            "last_search_results": _sanitize_api_context(payload.last_search_results),
            "requested_type": payload.requested_type,
            "requested_value": payload.requested_value,
        },
        reason=payload.reason or "product_not_found",
    )


def resolve_escalation_customer_fields(
    session: Optional["SessionState"],
    *,
    fallback_email: str = "",
    fallback_name: str = "",
) -> tuple[str, str, str]:
    """
    Best-effort caller identity for support handoff.

    Email priority: confirmed payment email → pending/offered → profile email.
    Name: greeting-safe session name, else fallback, else 'Customer'.
    """
    from ..dialogue.greeting import greeting_safe_name
    from ..payment.email_state import (
        get_canonical_confirmed_email,
        get_last_offered_payment_email,
        get_pending_payment_email,
    )

    phone = ""
    name = ""
    email = ""

    if session is not None:
        phone = (getattr(session, "from_number", "") or "").strip()
        name = greeting_safe_name(getattr(session, "caller_name", "") or "")
        email = get_canonical_confirmed_email(session)
        if not email:
            email = (
                get_pending_payment_email(session)
                or get_last_offered_payment_email(session)
                or (getattr(session, "pending_email", "") or "").strip().lower()
            )
        if not email:
            email = (getattr(session, "caller_email", "") or "").strip().lower()

    if not name:
        name = greeting_safe_name(fallback_name)
    if not name:
        name = "Customer"
    if not email and fallback_email:
        email = fallback_email.strip().lower()

    return name, email, phone


def _short_issue_text(payload: CustomerQueryEscalationPayload) -> str:
    for candidate in (
        payload.issue_detail,
        payload.reason_for_handoff,
        payload.issue_title,
        payload.what_customer_asked,
        payload.reason,
    ):
        text = (candidate or "").strip()
        if text:
            return text[:280]
    return "Customer requested support assistance."


def _build_email_body(
    payload: CustomerQueryEscalationPayload,
    *,
    conversation_summary: str = "",
) -> str:
    """Support team email — customer name, email, and request only (no call/session IDs)."""
    issue = _short_issue_text(payload)
    summary = (conversation_summary or payload.conversation_summary or "").strip()
    request_parts: list[str] = []
    if issue:
        request_parts.append(issue)
    asked = (payload.what_customer_asked or "").strip()
    if asked and asked not in issue:
        request_parts.append(asked[:500])
    if summary and summary not in " ".join(request_parts):
        request_parts.append(summary[:600])
    customer_request = " ".join(request_parts).strip() or "Customer requested support assistance."

    return "\n".join([
        "SureShot Books — Customer Support Request",
        "",
        f"Customer name: {payload.customer_name or 'Customer'}",
        f"Customer email: {payload.customer_email or 'unknown'}",
        f"Customer request: {customer_request[:900]}",
        "",
        "Please reply to the customer by email.",
    ])


async def send_support_handoff(
    payload: CustomerQueryEscalationPayload | dict[str, Any],
    *,
    session: Optional["SessionState"] = None,
    caller_text: str = "",
) -> str:
    """
    Summarize conversation (LLM), email support team via Resend, return JSON string.
    """
    from .conversation_summarizer import summarize_conversation_for_support

    settings = get_settings()

    if isinstance(payload, dict):
        data = dict(payload)
    else:
        data = payload.to_dict()

    if session:
        data.setdefault("session_id", getattr(session, "session_id", "") or "")
        data.setdefault("call_sid", getattr(session, "call_sid", "") or "")
        resolved_name, resolved_email, resolved_phone = resolve_escalation_customer_fields(
            session,
            fallback_name=data.get("customer_name", "") or "",
            fallback_email=data.get("customer_email", "") or "",
        )
        data.setdefault("customer_phone", resolved_phone)
        if resolved_name:
            data["customer_name"] = resolved_name
        if resolved_email:
            data["customer_email"] = resolved_email

    model = CustomerQueryEscalationPayload.from_dict(data)

    if not model.session_id and session:
        model.session_id = getattr(session, "session_id", "") or model.call_sid
    if not model.call_sid and session:
        model.call_sid = getattr(session, "call_sid", "") or ""

    if not (model.issue_title or model.issue_detail).strip():
        return json.dumps({
            "success": False,
            "error_code": "missing_issue",
            "customer_message": _CUSTOMER_MESSAGE_ASK_CONTACT,
        })

    if not model.customer_email.strip() or "@" not in model.customer_email:
        return json.dumps({
            "success": False,
            "error_code": "missing_customer_email",
            "customer_message": _CUSTOMER_MESSAGE_ASK_CONTACT,
        })

    if not getattr(settings, "SUPPORT_ESCALATION_ENABLED", True):
        return json.dumps({
            "success": False,
            "error_code": "escalation_disabled",
            "customer_message": (
                "I couldn't resolve that automatically. "
                "Please contact SureShot Books customer service by email."
            ),
        })

    support_to = resolve_support_email(settings)
    if not support_to:
        logger.error(
            "support_handoff_blocked call_sid=%s reason=support_email_not_configured",
            (model.call_sid or "")[:8],
        )
        return json.dumps({
            "success": False,
            "error_code": "support_email_not_configured",
            "customer_message": (
                "I couldn't resolve that automatically. "
                "Please email SureShot Books customer service directly."
            ),
        })

    if not settings.RESEND_API_KEY:
        logger.error(
            "support_handoff_blocked call_sid=%s reason=resend_not_configured",
            (model.call_sid or "")[:8],
        )
        return json.dumps({
            "success": False,
            "error_code": "resend_not_configured",
            "customer_message": (
                "I couldn't reach our team by email right now. Please try again shortly."
            ),
        })

    idem_key = model.idempotency_key()
    existing = _get_existing_record(idem_key)
    if existing and existing.get("success"):
        logger.info(
            "support_handoff_idempotent call_sid=%s type=%s",
            (model.call_sid or "")[:8],
            model.query_type,
        )
        return json.dumps({
            "success": True,
            "escalation_id": existing.get("escalation_id", ""),
            "idempotent": True,
            "customer_message": _CUSTOMER_MESSAGE_SUCCESS,
        })

    escalation_id = str(uuid.uuid4())
    from_addr = resolve_escalation_from_email(settings)
    customer_name = (model.customer_name or "Customer").strip()
    issue_label = _issue_type_label(model.query_type)
    subject = f"Voice Agent Support — {customer_name} — {issue_label}"

    llm_summary, _transcript = await summarize_conversation_for_support(
        session,
        caller_text=caller_text,
        issue_title=model.issue_title,
        issue_detail=model.issue_detail,
        api_context=model.api_context,
    )
    model.conversation_summary = llm_summary or model.conversation_summary
    body = _build_email_body(model, conversation_summary=llm_summary)

    logger.info(
        "support_handoff_send call_sid=%s type=%s name=%s email=%s phone=%s",
        (model.call_sid or "")[:8],
        model.query_type,
        customer_name[:20] or "unknown",
        _mask_email(model.customer_email),
        _mask_phone(model.customer_phone),
    )

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {settings.RESEND_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "from": from_addr,
                    "to": [support_to],
                    "subject": subject,
                    "text": body,
                    "reply_to": model.customer_email,
                },
            )
        if resp.status_code not in (200, 201):
            logger.error(
                "support_handoff_failed call_sid=%s status=%s",
                (model.call_sid or "")[:8],
                resp.status_code,
            )
            return json.dumps({
                "success": False,
                "error_code": "email_send_failed",
                "customer_message": (
                    "I had trouble notifying our team — please try again in a moment."
                ),
            })
    except Exception as exc:
        logger.error(
            "support_handoff_error call_sid=%s err=%s",
            (model.call_sid or "")[:8],
            type(exc).__name__,
        )
        return json.dumps({
            "success": False,
            "error_code": "email_send_error",
            "customer_message": (
                "I had trouble notifying our team — please try again in a moment."
            ),
        })

    record = {
        "success": True,
        "escalation_id": escalation_id,
        "created_at": time.time(),
        "call_sid": model.call_sid,
        "query_type": model.query_type,
        "issue_title": model.issue_title,
    }
    _save_record(idem_key, record)

    if session is not None:
        sent = list(getattr(session, "not_found_escalation_sent_keys", None) or [])
        if idem_key not in sent:
            sent.append(idem_key)
        session.not_found_escalation_sent_keys = sent
        try:
            from ..memory.postgres_store import persist_escalation_if_configured
            from ..workflow.hooks import schedule_workflow_event

            persist_escalation_if_configured(
                session,
                escalation_type="support_handoff",
                payload={
                    "query_type": model.query_type,
                    "issue_title": model.issue_title[:120],
                    "escalation_id": escalation_id,
                },
            )
            schedule_workflow_event(
                session,
                "escalation_created",
                {"type": "support_handoff", "query_type": model.query_type},
            )
        except Exception:
            pass

    return json.dumps({
        "success": True,
        "escalation_id": escalation_id,
        "customer_message": _CUSTOMER_MESSAGE_SUCCESS,
    })
