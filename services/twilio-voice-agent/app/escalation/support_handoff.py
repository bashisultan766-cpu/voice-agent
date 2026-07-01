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

_SUPPORT_EMAIL_SUBJECT = "User Support Request - Order/Product Issue"

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
    reason = (payload.reason or "product_not_found").strip()
    value = (payload.requested_value or "").strip()[:120]
    title_from_search = ""
    if isinstance(payload.last_search_results, dict):
        title_from_search = str(payload.last_search_results.get("title") or "").strip()

    if reason == "product_out_of_stock":
        issue_title = f"Out of stock — {value or title_from_search or query_type}"
        issue_detail = "Not available to order online."
    else:
        issue_title = f"Not found — {value or query_type}"
        issue_detail = "No catalog match."

    return CustomerQueryEscalationPayload(
        session_id=payload.session_id,
        call_sid=payload.call_sid,
        customer_phone=payload.customer_phone,
        customer_name=payload.customer_name,
        customer_email=payload.customer_email,
        query_type=query_type,
        issue_title=issue_title,
        issue_detail=issue_detail,
        what_customer_asked=(caller_text or payload.conversation_summary or "")[:500],
        what_agent_tried="Shopify catalog / ISBN search",
        tool_api_result=_sanitize_api_context(payload.last_search_results),
        reason_for_handoff=payload.reason or "product_not_found",
        recommended_next_action=(
            "Source from warehouse or partners and email the customer."
            if reason == "product_out_of_stock"
            else "Locate the item manually and email the customer."
        ),
        conversation_summary=payload.conversation_summary,
        api_context={
            "last_search_results": _sanitize_api_context(payload.last_search_results),
            "requested_type": payload.requested_type,
            "requested_value": payload.requested_value,
            "product_title": title_from_search,
            "quantity": payload.quantity,
            "facility_name": payload.facility_name,
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


_HANDOFF_NOISE_PAT = re.compile(
    r"^(yeah\.?|yes\.?|that'?s correct\.?|correct\.?|sure\.?|okay\.?|ok\.?)\s*",
    re.I,
)
_LLM_EMAIL_NOISE_PAT = re.compile(
    r"\b(subject:\s*.+|dear team\b.*|thank you for your attention\b.*|"
    r"please reply to the customer\b.*)",
    re.I | re.S,
)
_ISBN_IN_TEXT = re.compile(r"\b(?:97[89]\d{10}|\d{9}[\dXx]|\d{13})\b")


def _sanitize_spoken_request(text: str) -> str:
    """Drop email-confirm filler and LLM letter boilerplate from caller text."""
    t = (text or "").strip()
    if not t:
        return ""
    t = _LLM_EMAIL_NOISE_PAT.sub("", t).strip()
    for _ in range(4):
        if not _HANDOFF_NOISE_PAT.match(t):
            break
        t = _HANDOFF_NOISE_PAT.sub("", t, count=1).strip()
    return t


def _first_sentence(text: str, *, max_len: int = 160) -> str:
    t = (text or "").strip()
    if not t:
        return ""
    parts = re.split(r"[.!?]\s+", t, maxsplit=1)
    return parts[0][:max_len].strip()


def _compose_customer_request(payload: CustomerQueryEscalationPayload) -> str:
    """One short line for the support team — no LLM dump."""
    reason = (payload.reason_for_handoff or payload.reason or "").strip().lower()
    api = dict(payload.api_context or {})
    req_type = str(api.get("requested_type") or payload.query_type or "").lower()
    req_value = str(api.get("requested_value") or "").strip()
    title = str(api.get("product_title") or "").strip()
    lr = api.get("last_search_results") or {}
    if isinstance(lr, dict) and not title:
        title = str(lr.get("title") or "").strip()
    qty = api.get("quantity")
    facility = str(api.get("facility_name") or "").strip()

    if reason == "product_out_of_stock" or (
        isinstance(lr, dict) and lr.get("out_of_stock")
    ):
        label_parts: list[str] = []
        isbn = _ISBN_IN_TEXT.search(req_value)
        if isbn:
            label_parts.append(f"ISBN {isbn.group(0)}")
        elif req_value:
            label_parts.append(req_value[:80])
        if title and title.lower() not in " ".join(label_parts).lower():
            label_parts.append(f'"{title[:80]}"')
        item = " — ".join(label_parts) if label_parts else "Requested item"
        line = f"{item} — not available online. Source from warehouse/partners and email customer."
        if qty:
            line += f" Qty: {qty}."
        if facility:
            line += f" Facility: {facility[:60]}."
        return line[:280]

    if reason == "product_not_found":
        label = req_value[:80] or title[:80] or req_type or "item"
        return (
            f"Customer wants {req_type or 'product'}: {label}. "
            "Not in catalog — locate manually and email customer."
        )[:280]

    if payload.issue_title and len(payload.issue_title) <= 100:
        core = payload.issue_title.strip()
    else:
        core = _first_sentence(payload.issue_detail) or "Support assistance needed"

    action = (payload.recommended_next_action or "").strip()
    if action and len(core) < 100:
        return f"{core}. {action}"[:280]
    return core[:280]


def _summary_to_bullet_lines(summary: str, *, max_bullets: int = 5) -> list[str]:
    """Turn LLM summary into short bullet lines for the support email."""
    if not summary:
        return []

    def _clean_line(text: str) -> str:
        return re.sub(r"^(?:subject:\s*)", "", text.strip(), flags=re.I).strip()

    def _is_noise(text: str) -> bool:
        return bool(re.match(r"^dear\s+(?:team|backend)\b", text, re.I))

    def _add_candidate(text: str) -> None:
        line = _clean_line(text)
        if not line or _is_noise(line) or len(line) < 8:
            return
        if re.search(r"\bdear\s+(?:team|backend)\b", line, re.I):
            for part in re.split(r"[.!?]\s+", line):
                part = _clean_line(part)
                if part and not _is_noise(part) and len(part) >= 12:
                    bullets.append(part[:220])
                if len(bullets) >= max_bullets:
                    return
            return
        bullets.append(line[:220])

    bullets: list[str] = []
    for raw in re.split(r"[\n\r]+", summary.strip()):
        line = raw.strip().lstrip("-•*").strip()
        if line.startswith("- "):
            line = line[2:].strip()
        _add_candidate(line)
        if len(bullets) >= max_bullets:
            return bullets

    if bullets:
        return bullets

    for part in re.split(r"[.!?]\s+", summary.strip()):
        _add_candidate(part)
        if len(bullets) >= max_bullets:
            break
    return bullets


def _build_email_body(
    payload: CustomerQueryEscalationPayload,
    *,
    conversation_summary: str = "",
    analysis: dict[str, str] | None = None,
) -> str:
    """Single clean support email — issue summary, request, context, urgency."""
    name = (payload.customer_name or "Customer").strip()
    email = (payload.customer_email or "unknown").strip()
    request = _compose_customer_request(payload)
    analysis = analysis or {}
    issue_summary = (
        analysis.get("issue_summary")
        or payload.issue_title
        or request
    ).strip()
    user_intent = (analysis.get("user_intent") or payload.query_type or "support").strip()
    unresolved = (
        analysis.get("unresolved_needs")
        or payload.issue_detail
        or payload.recommended_next_action
        or "Manual follow-up required."
    ).strip()
    urgency = (analysis.get("urgency_level") or "medium").strip().lower()
    context_lines = _summary_to_bullet_lines(
        conversation_summary or payload.conversation_summary or "",
    )

    lines = [
        "SureShot Books — Support Handoff",
        "",
        f"Name: {name}",
        f"Email: {email}",
        "",
        f"Issue summary: {issue_summary}",
        f"User request: {request}",
        f"User intent: {user_intent}",
        f"Unresolved needs: {unresolved}",
        f"Urgency: {urgency}",
    ]
    if context_lines:
        lines.extend(["", "Conversation context:"])
        lines.extend(f"• {line}" for line in context_lines)
    lines.extend(["", "Reply to the customer by email."])
    return "\n".join(lines)


async def send_support_handoff(
    payload: CustomerQueryEscalationPayload | dict[str, Any],
    *,
    session: Optional["SessionState"] = None,
    caller_text: str = "",
) -> str:
    """
    Analyze conversation, email support team via Resend, return JSON string.
    """
    from .conversation_summarizer import analyze_conversation_for_support

    settings = get_settings()

    if isinstance(payload, dict):
        data = dict(payload)
    else:
        data = payload.to_dict()

    if session:
        data.setdefault("session_id", getattr(session, "session_id", "") or "")
        data.setdefault("call_sid", getattr(session, "call_sid", "") or "")
        captured_email = (data.get("customer_email") or "").strip().lower()
        if captured_email and "@" in captured_email:
            data["customer_email"] = captured_email
            data["customer_phone"] = ""
            if not (data.get("customer_name") or "").strip():
                data["customer_name"] = "Customer"
        else:
            resolved_name, resolved_email, resolved_phone = resolve_escalation_customer_fields(
                session,
                fallback_name=data.get("customer_name", "") or "",
                fallback_email=data.get("customer_email", "") or "",
            )
            if resolved_name:
                data["customer_name"] = resolved_name
            if resolved_email:
                data["customer_email"] = resolved_email
            data.setdefault("customer_phone", resolved_phone)

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
    subject = _SUPPORT_EMAIL_SUBJECT

    analysis, transcript = await analyze_conversation_for_support(
        session,
        caller_text=_sanitize_spoken_request(caller_text),
        issue_title=model.issue_title,
        issue_detail=model.issue_detail,
        api_context=model.api_context,
    )
    model.conversation_summary = (
        f"Issue: {analysis.get('issue_summary', '')}\n"
        f"Intent: {analysis.get('user_intent', '')}\n"
        f"Unresolved: {analysis.get('unresolved_needs', '')}\n"
        f"Urgency: {analysis.get('urgency_level', 'medium')}"
    ).strip()
    model.conversation_transcript = transcript
    body = _build_email_body(model, conversation_summary=model.conversation_summary, analysis=analysis)

    if session is not None:
        session.support_handoff_contact = {
            "email": model.customer_email.strip().lower(),
            "name": customer_name,
            "issue_summary": analysis.get("issue_summary", "") or model.issue_title,
        }

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
