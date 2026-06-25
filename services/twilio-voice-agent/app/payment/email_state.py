"""
Canonical payment email state for the voice agent (v4.21).

Single source of truth: ``session.confirmed_email`` after verbal confirmation.
All payment gates and send paths must read/write through these helpers.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


def sync_payment_email_fields(session: "SessionState") -> None:
    """Align legacy/v4.19 email fields with canonical confirmed_email."""
    pending = (
        (getattr(session, "pending_payment_email", "") or "").strip()
        or (getattr(session, "pending_email", "") or "").strip()
    )
    confirmed = (getattr(session, "confirmed_email", "") or "").strip().lower()

    if pending and not getattr(session, "pending_payment_email", ""):
        session.pending_payment_email = pending
    if pending and not getattr(session, "pending_email", ""):
        session.pending_email = pending

    if confirmed:
        session.confirmed_email = confirmed
        session.payment_email_confirmed = True
        session.awaiting_payment_email_confirmation = False
        session.pending_payment_email = ""
        session.pending_email = ""
        if not getattr(session, "caller_email", ""):
            session.caller_email = confirmed
    else:
        session.payment_email_confirmed = False
        session.awaiting_payment_email_confirmation = bool(pending)


def get_canonical_confirmed_email(session: "SessionState") -> str:
    """Return the confirmed payment email, or empty string."""
    sync_payment_email_fields(session)
    return (getattr(session, "confirmed_email", "") or "").strip().lower()


def get_pending_payment_email(session: "SessionState") -> str:
    sync_payment_email_fields(session)
    return (
        (getattr(session, "pending_payment_email", "") or "").strip().lower()
        or (getattr(session, "pending_email", "") or "").strip().lower()
    )


def set_pending_payment_email(session: "SessionState", email: str) -> None:
    normalized = (email or "").strip().lower()
    session.pending_payment_email = normalized
    session.pending_email = normalized
    session.confirmed_email = ""
    session.payment_email_confirmed = False
    session.awaiting_payment_email_confirmation = True
    session.payment_flow_status = "awaiting_email_confirmation"
    session.last_payment_attempt_status = "pending_confirmation"


def confirm_payment_email(session: "SessionState") -> bool:
    """Promote pending email to confirmed_email. Returns False if no pending."""
    pending = get_pending_payment_email(session)
    if not pending:
        return False
    session.confirmed_email = pending
    session.caller_email = pending
    session.pending_payment_email = ""
    session.pending_email = ""
    session.payment_email_confirmed = True
    session.awaiting_payment_email_confirmation = False
    session.email_confidence = "high"
    session.payment_flow_status = "awaiting_send_confirmation"
    session.last_payment_attempt_status = "confirmed"
    sync_payment_email_fields(session)
    return True


def reject_pending_payment_email(session: "SessionState") -> None:
    rejected = get_pending_payment_email(session)
    session.pending_payment_email = ""
    session.pending_email = ""
    session.awaiting_payment_email_confirmation = False
    session.payment_email_confirmed = False
    session.email_confidence = "low"
    session.email_rejected_count = getattr(session, "email_rejected_count", 0) + 1
    if rejected:
        candidates = getattr(session, "rejected_email_candidates", None) or []
        if rejected.lower() not in [c.lower() for c in candidates]:
            session.rejected_email_candidates = [*candidates, rejected]
    session.payment_flow_status = "awaiting_email"
    session.last_payment_attempt_status = "rejected"
    sync_payment_email_fields(session)


def log_payment_flow_diagnostics(session: "SessionState", *, stage: str = "") -> None:
    """Safe diagnostics — booleans and counts only, no full email or URLs."""
    sync_payment_email_fields(session)
    pending = get_pending_payment_email(session)
    confirmed = get_canonical_confirmed_email(session)
    try:
        from ..cart.session import get_ledger

        cart_count = get_ledger(session).confirmed_count()
    except Exception:  # noqa: BLE001
        items = getattr(session, "cart_items", None) or []
        cart_count = len(items)

    sid = (getattr(session, "call_sid", "") or "")[:6]
    logger.info(
        "payment_flow_diag sid=%s stage=%s "
        "normalized_email_present=%s pending_payment_email_present=%s "
        "confirmed_email_present=%s payment_email_confirmed=%s "
        "cart_item_count=%d checkout_created=%s "
        "email_send_attempted=%s email_send_success=%s",
        sid,
        stage or "unknown",
        bool(pending or confirmed),
        bool(pending),
        bool(confirmed),
        bool(getattr(session, "payment_email_confirmed", False)),
        cart_count,
        bool(getattr(session, "pending_checkout_url", "")),
        getattr(session, "last_payment_attempt_status", "") in (
            "success", "failed", "blocked", "pending_confirmation", "confirmed",
        ),
        getattr(session, "last_payment_attempt_status", "") == "success",
    )
