"""Payment idempotency — duplicate checkout/email protection (v4.15.0)."""
from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from ..payment.safety import _mask_email
from .certification_config import idempotency_ttl_seconds

logger = logging.getLogger(__name__)

_STORE: dict[str, "IdempotencyRecord"] = {}


@dataclass
class IdempotencyRecord:
    key: str
    status: str  # pending | created | emailed | failed
    checkout_id: str = ""
    masked_email: str = ""
    created_at: float = field(default_factory=time.time)
    cart_snapshot_hash: str = ""
    resend_message_id: str = ""
    group_id: str = ""
    call_sid: str = ""


@dataclass
class IdempotencyCheckResult:
    allowed: bool
    action: str  # proceed | block_pending | block_emailed | allow_retry
    message: str = ""
    record: IdempotencyRecord | None = None


def _short_sid(sid: str) -> str:
    return sid[:6] if sid else "?"


def _purge_expired() -> None:
    ttl = idempotency_ttl_seconds()
    now = time.time()
    expired = [k for k, r in _STORE.items() if now - r.created_at > ttl]
    for k in expired:
        _STORE.pop(k, None)


def _cart_snapshot_hash(items: list[dict]) -> str:
    parts = []
    for item in sorted(items, key=lambda i: (i.get("variant_id") or "", i.get("title") or "")):
        parts.append(f"{item.get('variant_id')}:{item.get('quantity', 1)}")
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]


def compute_idempotency_key(
    *,
    call_sid: str,
    group_id: str,
    items: list[dict],
    confirmed_email: str,
    cart_version: str = "",
) -> str:
    variant_parts = sorted(
        f"{i.get('variant_id')}:{int(i.get('quantity', 1) or 1)}"
        for i in items
        if i.get("variant_id")
    )
    raw = "|".join([
        call_sid or "",
        group_id or "default",
        ",".join(variant_parts),
        (confirmed_email or "").lower().strip(),
        cart_version or _cart_snapshot_hash(items),
    ])
    return hashlib.sha256(raw.encode()).hexdigest()


def check_idempotency(key: str) -> IdempotencyCheckResult:
    _purge_expired()
    logger.info("payment_idempotency_checked sid=? key=%s", key[:12])
    record = _STORE.get(key)
    if not record:
        return IdempotencyCheckResult(allowed=True, action="proceed")

    if record.status == "pending":
        logger.info("payment_duplicate_blocked sid=? reason=pending key=%s", key[:12])
        return IdempotencyCheckResult(
            allowed=False,
            action="block_pending",
            message="I'm already preparing that payment link.",
            record=record,
        )

    if record.status == "emailed":
        masked = record.masked_email or "***@***"
        logger.info("payment_duplicate_blocked sid=? reason=emailed key=%s", key[:12])
        return IdempotencyCheckResult(
            allowed=False,
            action="block_emailed",
            message=f"I already sent that payment link to {masked}.",
            record=record,
        )

    if record.status == "failed":
        logger.info("payment_idempotency_retry_allowed sid=? key=%s", key[:12])
        return IdempotencyCheckResult(
            allowed=True,
            action="allow_retry",
            message="",
            record=record,
        )

    if record.status == "created":
        return IdempotencyCheckResult(
            allowed=False,
            action="block_pending",
            message="I'm already preparing that payment link.",
            record=record,
        )

    return IdempotencyCheckResult(allowed=True, action="proceed", record=record)


def create_idempotency_record(
    key: str,
    *,
    call_sid: str = "",
    group_id: str = "",
    items: list[dict] | None = None,
    confirmed_email: str = "",
) -> IdempotencyRecord:
    _purge_expired()
    masked = _mask_email(confirmed_email) if confirmed_email else ""
    record = IdempotencyRecord(
        key=key,
        status="pending",
        masked_email=masked,
        cart_snapshot_hash=_cart_snapshot_hash(items or []),
        group_id=group_id,
        call_sid=call_sid,
    )
    _STORE[key] = record
    logger.info(
        "payment_idempotency_record_created sid=%s group_id=%s key=%s",
        _short_sid(call_sid),
        (group_id or "")[:8],
        key[:12],
    )
    return record


def mark_checkout_created(key: str, checkout_id: str = "") -> None:
    record = _STORE.get(key)
    if not record:
        return
    record.status = "created"
    record.checkout_id = checkout_id
    logger.info("payment_idempotency_checkout_created key=%s checkout_id=%s", key[:12], checkout_id[:8] if checkout_id else "")


def mark_emailed(key: str, *, resend_message_id: str = "") -> None:
    record = _STORE.get(key)
    if not record:
        return
    record.status = "emailed"
    record.resend_message_id = resend_message_id
    logger.info(
        "payment_idempotency_marked_emailed key=%s message_id=%s",
        key[:12],
        (resend_message_id or "")[:8],
    )


def mark_failed(key: str) -> None:
    record = _STORE.get(key)
    if not record:
        return
    record.status = "failed"
    logger.info("payment_idempotency_marked_failed key=%s", key[:12])


def clear_idempotency_store() -> None:
    """Test helper."""
    _STORE.clear()


def get_record(key: str) -> IdempotencyRecord | None:
    _purge_expired()
    return _STORE.get(key)
