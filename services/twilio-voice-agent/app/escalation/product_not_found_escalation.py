"""
Product-not-found escalation — email SureShot support with full request details.

Idempotent per call_sid + requested_type + requested_value.
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from typing import Any, Optional, TYPE_CHECKING

import httpx

from ..config import get_settings
from .models import ProductNotFoundEscalationPayload

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_CUSTOMER_MESSAGE_SUCCESS = (
    "I'll forward this to our team. If we can source it, they'll contact you by email."
)

_STORE: dict[str, dict[str, Any]] = {}
_IDEM_PREFIX = "not_found_escalation:"
_SYNC_REDIS: Any = None


def _mask_phone(number: str) -> str:
    digits = "".join(c for c in (number or "") if c.isdigit())
    if len(digits) >= 4:
        return f"***{digits[-4:]}"
    return "***"


def _mask_email(email: str) -> str:
    if not email or "@" not in email:
        return "***"
    local, _, domain = email.partition("@")
    if len(local) <= 2:
        return f"{local[0]}***@{domain}"
    return f"{local[0]}***{local[-1]}@{domain}"


def resolve_support_email(settings=None) -> str:
    s = settings or get_settings()
    for attr in ("SUPPORT_EMAIL", "JESSICA_EMAIL", "CUSTOMER_SERVICE_EMAIL"):
        val = (getattr(s, attr, "") or "").strip()
        if val:
            return val
    return ""


def resolve_escalation_from_email(settings=None) -> str:
    s = settings or get_settings()
    custom = (getattr(s, "SUPPORT_ESCALATION_FROM_EMAIL", "") or "").strip()
    if custom:
        return custom
    from_name = (getattr(s, "RESEND_FROM_NAME", "") or "SureShot Books").strip()
    from_addr = (getattr(s, "RESEND_FROM_EMAIL", "") or "").strip()
    if from_addr:
        return f"{from_name} <{from_addr}>" if from_name else from_addr
    return ""


def _get_sync_redis() -> Any:
    global _SYNC_REDIS
    if _SYNC_REDIS is not None:
        return _SYNC_REDIS
    try:
        from ..config import get_settings

        settings = get_settings()
        if not settings.REDIS_URL:
            return None
        import redis

        client = redis.from_url(settings.REDIS_URL, decode_responses=True, socket_connect_timeout=2)
        client.ping()
        _SYNC_REDIS = client
        return _SYNC_REDIS
    except Exception as exc:
        logger.warning("escalation_idempotency_redis_unavailable err=%s", type(exc).__name__)
        return None


def _idem_redis_key(key: str) -> str:
    digest = hashlib.sha256(key.encode()).hexdigest()[:32]
    return f"{_IDEM_PREFIX}{digest}"


def _get_existing_record(idem_key: str) -> Optional[dict[str, Any]]:
    redis_client = _get_sync_redis()
    if redis_client is not None:
        try:
            raw = redis_client.get(_idem_redis_key(idem_key))
            if raw:
                return json.loads(raw)
        except Exception:
            pass
    return _STORE.get(idem_key)


def _save_record(idem_key: str, record: dict[str, Any], *, ttl_seconds: int = 86400) -> None:
    _STORE[idem_key] = record
    redis_client = _get_sync_redis()
    if redis_client is not None:
        try:
            redis_client.setex(
                _idem_redis_key(idem_key),
                ttl_seconds,
                json.dumps(record),
            )
        except Exception:
            pass


def _build_email_body(payload: ProductNotFoundEscalationPayload) -> str:
    lines = [
        "SureShot Books — Product Not Found Escalation",
        "",
        f"Escalation ID: {payload.session_id}",
        f"Call SID: {payload.call_sid}",
        f"Session ID: {payload.session_id}",
        f"Created: {payload.created_at}",
        "",
        "CUSTOMER",
        f"  Phone: {payload.customer_phone or 'unknown'}",
        f"  Name: {payload.customer_name or 'unknown'}",
        f"  Email: {payload.customer_email or 'unknown'}",
        "",
        "REQUEST",
        f"  Type: {payload.requested_type}",
        f"  Value: {payload.requested_value}",
    ]
    if payload.quantity is not None:
        lines.append(f"  Quantity: {payload.quantity}")
    if payload.facility_name:
        lines.append(f"  Facility: {payload.facility_name}")
    lines.extend([
        "",
        "REASON",
        f"  {payload.reason}",
        "",
        "CONVERSATION SUMMARY",
        f"  {payload.conversation_summary or 'N/A'}",
        "",
        "LAST SEARCH RESULTS",
        json.dumps(payload.last_search_results, indent=2, default=str)[:2000],
    ])
    return "\n".join(lines)


async def create_product_not_found_escalation(
    payload: ProductNotFoundEscalationPayload | dict[str, Any],
    *,
    session: Optional["SessionState"] = None,
) -> str:
    """
    Validate payload, send support email via Resend, return JSON string.

    Idempotent per call_sid + requested_type + requested_value.
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
        if not data.get("facility_name"):
            data["facility_name"] = getattr(session, "last_facility_name", "") or ""

    model = ProductNotFoundEscalationPayload.from_dict(data)

    if not model.session_id and session:
        model.session_id = getattr(session, "session_id", "") or model.call_sid
    if not model.call_sid and session:
        model.call_sid = getattr(session, "call_sid", "") or ""

    if not model.requested_value.strip():
        return json.dumps({
            "success": False,
            "error_code": "missing_requested_value",
            "customer_message": (
                "I need the item you were looking for before I can forward it to our team."
            ),
        })

    if not model.customer_email.strip() or "@" not in model.customer_email:
        return json.dumps({
            "success": False,
            "error_code": "missing_customer_email",
            "customer_message": (
                "That item is not showing as available right now. "
                "I can forward this to our team to check manually. "
                "What email should they use to contact you?"
            ),
        })

    if not getattr(settings, "SUPPORT_ESCALATION_ENABLED", True):
        return json.dumps({
            "success": False,
            "error_code": "escalation_disabled",
            "customer_message": (
                "That item is not showing as available right now. "
                "Please contact SureShot Books customer service by email."
            ),
        })

    support_to = resolve_support_email(settings)
    if not support_to:
        logger.error(
            "product_not_found_escalation_blocked call_sid=%s reason=support_email_not_configured",
            (model.call_sid or "")[:8],
        )
        return json.dumps({
            "success": False,
            "error_code": "support_email_not_configured",
            "customer_message": (
                "That item is not showing as available right now. "
                "Our team could not be notified automatically — "
                "please email SureShot Books customer service directly."
            ),
        })

    if not settings.RESEND_API_KEY:
        logger.error(
            "product_not_found_escalation_blocked call_sid=%s reason=resend_not_configured",
            (model.call_sid or "")[:8],
        )
        return json.dumps({
            "success": False,
            "error_code": "resend_not_configured",
            "customer_message": (
                "That item is not showing as available right now. "
                "I could not reach our team by email right now. Please try again shortly."
            ),
        })

    idem_key = model.idempotency_key()
    existing = _get_existing_record(idem_key)
    if existing and existing.get("success"):
        logger.info(
            "product_not_found_escalation_idempotent call_sid=%s type=%s",
            (model.call_sid or "")[:8],
            model.requested_type,
        )
        return json.dumps({
            "success": True,
            "escalation_id": existing.get("escalation_id", ""),
            "idempotent": True,
            "customer_message": _CUSTOMER_MESSAGE_SUCCESS,
        })

    escalation_id = str(uuid.uuid4())
    from_addr = resolve_escalation_from_email(settings)
    subject = (
        f"[Voice Agent] Product not found — {model.requested_type}: "
        f"{model.requested_value[:60]}"
    )
    body = _build_email_body(model)

    logger.info(
        "product_not_found_escalation_send call_sid=%s type=%s value_len=%d "
        "email=%s phone=%s",
        (model.call_sid or "")[:8],
        model.requested_type,
        len(model.requested_value),
        _mask_email(model.customer_email),
        _mask_phone(model.customer_phone),
    )

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
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
                "product_not_found_escalation_failed call_sid=%s status=%s",
                (model.call_sid or "")[:8],
                resp.status_code,
            )
            return json.dumps({
                "success": False,
                "error_code": "email_send_failed",
                "customer_message": (
                    "That item is not showing as available right now. "
                    "I had trouble notifying our team — please try again in a moment."
                ),
            })
    except Exception as exc:
        logger.error(
            "product_not_found_escalation_error call_sid=%s err=%s",
            (model.call_sid or "")[:8],
            type(exc).__name__,
        )
        return json.dumps({
            "success": False,
            "error_code": "email_send_error",
            "customer_message": (
                "That item is not showing as available right now. "
                "I had trouble notifying our team — please try again in a moment."
            ),
        })

    record = {
        "success": True,
        "escalation_id": escalation_id,
        "created_at": time.time(),
        "call_sid": model.call_sid,
        "requested_type": model.requested_type,
        "requested_value": model.requested_value,
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
                escalation_type="product_not_found",
                payload={
                    "requested_type": model.requested_type,
                    "requested_value": model.requested_value[:120],
                    "escalation_id": escalation_id,
                },
            )
            schedule_workflow_event(
                session,
                "escalation_created",
                {
                    "type": "product_not_found",
                    "requested_type": model.requested_type,
                },
            )
        except Exception:
            pass

    return json.dumps({
        "success": True,
        "escalation_id": escalation_id,
        "customer_message": _CUSTOMER_MESSAGE_SUCCESS,
    })
