"""
Customer query escalation — LLM summary + email to SureShot backend team.

Used when Shopify/API cannot resolve order, product, or other customer requests.
Default destination: jessica@sureshotbooks.com (via SUPPORT_EMAIL).
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, Optional, TYPE_CHECKING

import httpx

from ..config import get_settings
from .conversation_summarizer import summarize_conversation_for_support
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

_IDEM_PREFIX = "customer_query_escalation:"

_CUSTOMER_MESSAGE_SUCCESS = (
    "I've sent your request to our backend team. "
    "They'll review everything we discussed and contact you by email."
)

_CUSTOMER_MESSAGE_ASK_EMAIL = (
    "I couldn't find that in our system right now. "
    "I can forward your full request to our backend team so they can help manually. "
    "What email should they use to reach you?"
)


def _idem_redis_key(key: str) -> str:
    return f"{_IDEM_PREFIX}{key}"


def product_payload_to_customer_query(
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
        conversation_summary=payload.conversation_summary,
        api_context={
            "last_search_results": payload.last_search_results,
            "requested_type": payload.requested_type,
            "requested_value": payload.requested_value,
        },
        reason=payload.reason or "product_not_found",
    )


def _build_email_body(payload: CustomerQueryEscalationPayload) -> str:
    lines = [
        "SureShot Books — Customer Query Escalation (Voice Agent)",
        "",
        f"Escalation ID: {payload.session_id}",
        f"Call SID: {payload.call_sid}",
        f"Created: {payload.created_at}",
        "",
        "CUSTOMER (reach out to resolve)",
        f"  Name: {payload.customer_name or 'unknown'}",
        f"  Email: {payload.customer_email or 'unknown'}",
        f"  Phone: {payload.customer_phone or 'unknown'}",
        "",
        "QUERY",
        f"  Type: {payload.query_type}",
        f"  Title: {payload.issue_title}",
        f"  Detail: {payload.issue_detail}",
        "",
        "REASON",
        f"  {payload.reason}",
        "",
        "CONVERSATION SUMMARY (LLM)",
        payload.conversation_summary or "N/A",
        "",
        "FULL TRANSCRIPT",
        (payload.conversation_transcript or "N/A")[:4000],
    ]
    if payload.api_context:
        lines.extend([
            "",
            "API / SYSTEM CONTEXT",
            json.dumps(payload.api_context, indent=2, default=str)[:2500],
        ])
    lines.extend([
        "",
        "---",
        "Reply to the customer email above when you have an update.",
    ])
    return "\n".join(lines)


async def create_customer_query_escalation(
    payload: CustomerQueryEscalationPayload | dict[str, Any],
    *,
    session: Optional["SessionState"] = None,
    caller_text: str = "",
) -> str:
    """
    Summarize conversation (LLM), email backend team via Resend, return JSON string.
    """
    settings = get_settings()

    if isinstance(payload, dict):
        data = dict(payload)
    else:
        data = payload.to_dict()

    if session:
        data.setdefault("session_id", getattr(session, "session_id", "") or "")
        data.setdefault("call_sid", getattr(session, "call_sid", "") or "")
        data.setdefault("customer_phone", getattr(session, "from_number", "") or "")
        data.setdefault("customer_name", getattr(session, "caller_name", "") or "")

    model = CustomerQueryEscalationPayload.from_dict(data)

    if not model.session_id and session:
        model.session_id = getattr(session, "session_id", "") or model.call_sid
    if not model.call_sid and session:
        model.call_sid = getattr(session, "call_sid", "") or ""

    if not (model.issue_title or model.issue_detail).strip():
        return json.dumps({
            "success": False,
            "error_code": "missing_issue",
            "customer_message": _CUSTOMER_MESSAGE_ASK_EMAIL,
        })

    if not model.customer_email.strip() or "@" not in model.customer_email:
        return json.dumps({
            "success": False,
            "error_code": "missing_customer_email",
            "customer_message": _CUSTOMER_MESSAGE_ASK_EMAIL,
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
            "customer_query_escalation_blocked call_sid=%s reason=support_email_not_configured",
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
            "customer_query_escalation_blocked call_sid=%s reason=resend_not_configured",
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
            "customer_query_escalation_idempotent call_sid=%s type=%s",
            (model.call_sid or "")[:8],
            model.query_type,
        )
        return json.dumps({
            "success": True,
            "escalation_id": existing.get("escalation_id", ""),
            "idempotent": True,
            "customer_message": _CUSTOMER_MESSAGE_SUCCESS,
        })

    summary, transcript = await summarize_conversation_for_support(
        session,
        caller_text=caller_text,
        issue_title=model.issue_title,
        issue_detail=model.issue_detail,
        api_context=model.api_context,
    )
    if summary:
        model.conversation_summary = summary
    if transcript:
        model.conversation_transcript = transcript

    escalation_id = str(uuid.uuid4())
    from_addr = resolve_escalation_from_email(settings)
    subject = (
        f"[Voice Agent] Customer query — {model.query_type}: "
        f"{(model.customer_name or 'Caller')} — "
        f"{model.issue_title[:50]}"
    )
    body = _build_email_body(model)

    logger.info(
        "customer_query_escalation_send call_sid=%s type=%s name=%s email=%s phone=%s",
        (model.call_sid or "")[:8],
        model.query_type,
        (model.customer_name or "")[:20] or "unknown",
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
                "customer_query_escalation_failed call_sid=%s status=%s",
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
            "customer_query_escalation_error call_sid=%s err=%s",
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
                escalation_type="customer_query",
                payload={
                    "query_type": model.query_type,
                    "issue_title": model.issue_title[:120],
                    "escalation_id": escalation_id,
                },
            )
            schedule_workflow_event(
                session,
                "escalation_created",
                {
                    "type": "customer_query",
                    "query_type": model.query_type,
                },
            )
        except Exception:
            pass

    return json.dumps({
        "success": True,
        "escalation_id": escalation_id,
        "customer_message": _CUSTOMER_MESSAGE_SUCCESS,
    })
