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
    return "jessica@sureshotbooks.com"


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
                "I couldn't find that in our system right now. "
                "I can forward your full request to our backend team so they can help manually. "
                "What email should they use to reach you?"
            ),
        })

    from .support_handoff import product_payload_to_support_handoff, send_support_handoff

    handoff = product_payload_to_support_handoff(model, session=session)
    return await send_support_handoff(handoff, session=session)
