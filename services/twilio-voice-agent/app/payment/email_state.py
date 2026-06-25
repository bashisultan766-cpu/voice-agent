"""
Canonical payment email state for the voice agent (v4.26).

Single source of truth after verbal confirmation: ``session.confirmed_email``.
``last_offered_payment_email`` survives repeat-email / LLM spell turns until
confirmed or replaced.
"""
from __future__ import annotations

import hashlib
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

PAYMENT_EMAIL_STATE_VERSION = "v4.33"
EMAIL_CAPTURE_SHORT_CIRCUIT_ENABLED = True
PAYMENT_AUTO_SEND_ENABLED = True
CREATE_CHECKOUT_CUSTOMER_FACING = False
SEND_PAYMENT_LINK_CUSTOMER_FACING = True


def _email_hash(email: str) -> str:
    if not email:
        return ""
    return hashlib.sha256(email.encode("utf-8")).hexdigest()[:8]


def _sync_checkout_fields(session: "SessionState") -> None:
    """Keep checkout_url / checkout_id aligned with legacy pending_* fields."""
    pending_url = (getattr(session, "pending_checkout_url", "") or "").strip()
    pending_id = (getattr(session, "pending_draft_order_id", "") or "").strip()
    if pending_url:
        session.checkout_url = pending_url
    elif getattr(session, "checkout_url", ""):
        session.pending_checkout_url = session.checkout_url
    if pending_id:
        session.checkout_id = pending_id
    elif getattr(session, "checkout_id", ""):
        session.pending_draft_order_id = session.checkout_id


def transition_payment_state(
    session: "SessionState",
    from_state: str,
    to_state: str,
) -> None:
    sid = (getattr(session, "call_sid", "") or "")[:6]
    logger.info(
        "payment_state_transition sid=%s from=%s to=%s",
        sid,
        from_state or "unknown",
        to_state or "unknown",
    )
    session.payment_flow_status = to_state


def sync_payment_email_fields(session: "SessionState") -> None:
    """Align legacy fields with canonical confirmed_email."""
    pending = (
        (getattr(session, "pending_payment_email", "") or "").strip().lower()
        or (getattr(session, "pending_email", "") or "").strip().lower()
    )
    confirmed = (getattr(session, "confirmed_email", "") or "").strip().lower()
    offered = (getattr(session, "last_offered_payment_email", "") or "").strip().lower()

    if pending:
        session.pending_payment_email = pending
        session.pending_email = pending
        if not offered:
            session.last_offered_payment_email = pending

    if confirmed:
        session.confirmed_email = confirmed
        session.payment_email_confirmed = True
        session.awaiting_payment_email_confirmation = False
        session.awaiting_payment_email = False
        session.pending_payment_email = ""
        session.pending_email = ""
        if not getattr(session, "caller_email", ""):
            session.caller_email = confirmed
    else:
        session.payment_email_confirmed = False
        session.awaiting_payment_email_confirmation = bool(pending or offered)

    _sync_checkout_fields(session)


def get_canonical_confirmed_email(session: "SessionState") -> str:
    sync_payment_email_fields(session)
    return (getattr(session, "confirmed_email", "") or "").strip().lower()


def get_pending_payment_email(session: "SessionState") -> str:
    sync_payment_email_fields(session)
    pending = (
        (getattr(session, "pending_payment_email", "") or "").strip().lower()
        or (getattr(session, "pending_email", "") or "").strip().lower()
    )
    if pending:
        return pending
    return (getattr(session, "last_offered_payment_email", "") or "").strip().lower()


def get_last_offered_payment_email(session: "SessionState") -> str:
    return (getattr(session, "last_offered_payment_email", "") or "").strip().lower()


def set_pending_payment_email(session: "SessionState", email: str) -> None:
    normalized = (email or "").strip().lower()
    if not normalized:
        return
    session.last_offered_payment_email = normalized
    session.pending_payment_email = normalized
    session.pending_email = normalized
    session.confirmed_email = ""
    session.payment_email_confirmed = False
    session.awaiting_payment_email_confirmation = True
    session.awaiting_payment_email = False
    session.payment_flow_status = "awaiting_email_confirmation"
    session.last_payment_attempt_status = "pending_confirmation"
    session.payment_link_sent = False
    session.email_send_success = False


def confirm_payment_email(session: "SessionState") -> bool:
    """Promote pending/last-offered email to confirmed_email."""
    pending = (
        (getattr(session, "pending_payment_email", "") or "").strip().lower()
        or (getattr(session, "pending_email", "") or "").strip().lower()
        or (getattr(session, "last_offered_payment_email", "") or "").strip().lower()
    )
    if not pending or "@" not in pending:
        return False

    session.confirmed_email = pending
    session.caller_email = pending
    session.last_offered_payment_email = pending
    session.pending_payment_email = ""
    session.pending_email = ""
    session.payment_email_confirmed = True
    session.awaiting_payment_email_confirmation = False
    session.awaiting_payment_email = False
    session.email_confidence = "high"
    session.payment_flow_status = "awaiting_send_confirmation"
    session.last_payment_attempt_status = "confirmed"
    sync_payment_email_fields(session)
    return True


def reject_pending_payment_email(session: "SessionState") -> None:
    rejected = get_pending_payment_email(session)
    session.pending_payment_email = ""
    session.pending_email = ""
    session.confirmed_email = ""
    session.payment_email_confirmed = False
    session.awaiting_payment_email_confirmation = False
    session.awaiting_payment_email = True
    session.last_offered_payment_email = ""
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
    """Safe diagnostics — booleans, counts, email hash only."""
    sync_payment_email_fields(session)
    pending = get_pending_payment_email(session)
    confirmed = get_canonical_confirmed_email(session)
    try:
        from ..cart.session import get_ledger

        cart_count = get_ledger(session).confirmed_count()
    except Exception:  # noqa: BLE001
        items = getattr(session, "cart_items", None) or []
        cart_count = len(items)

    try:
        from ..config import get_settings

        resend_ok = bool(
            get_settings().RESEND_API_KEY and get_settings().RESEND_FROM_EMAIL
        )
    except Exception:  # noqa: BLE001
        resend_ok = False

    sid = (getattr(session, "call_sid", "") or "")[:6]
    checkout_url = (
        getattr(session, "checkout_url", "")
        or getattr(session, "pending_checkout_url", "")
    )
    logger.info(
        "payment_flow_diag sid=%s stage=%s "
        "confirmed_email_present=%s confirmed_email_hash=%s "
        "payment_email_confirmed=%s awaiting_payment_email_confirmation=%s "
        "pending_payment_email_present=%s last_offered_present=%s "
        "cart_item_count=%d checkout_url_present=%s resend_config_present=%s "
        "email_send_attempted=%s email_send_success=%s payment_link_sent=%s",
        sid,
        stage or "unknown",
        bool(confirmed),
        _email_hash(confirmed),
        bool(getattr(session, "payment_email_confirmed", False)),
        bool(getattr(session, "awaiting_payment_email_confirmation", False)),
        bool(pending and pending != confirmed),
        bool(getattr(session, "last_offered_payment_email", "")),
        cart_count,
        bool(checkout_url),
        resend_ok,
        bool(getattr(session, "email_send_attempted", False)),
        bool(getattr(session, "email_send_success", False)),
        bool(getattr(session, "payment_link_sent", False)),
    )


def assert_ready_for_payment_send(session: "SessionState", *, stage: str) -> bool:
    """
    Hard check before send_payment_link. Logs and returns False if not ready.
    Makes ``no_email`` after confirmation impossible when this passes.
    """
    sync_payment_email_fields(session)
    confirmed = get_canonical_confirmed_email(session)
    ready = bool(
        confirmed
        and "@" in confirmed
        and getattr(session, "payment_email_confirmed", False)
        and not getattr(session, "awaiting_payment_email_confirmation", False)
    )
    if not ready:
        logger.error(
            "payment_send_blocked sid=%s stage=%s reason=email_unconfirmed "
            "confirmed_email_present=%s payment_email_confirmed=%s "
            "awaiting_confirmation=%s",
            (getattr(session, "call_sid", "") or "")[:6],
            stage,
            bool(confirmed),
            bool(getattr(session, "payment_email_confirmed", False)),
            bool(getattr(session, "awaiting_payment_email_confirmation", False)),
        )
    log_payment_flow_diagnostics(session, stage=stage)
    return ready
