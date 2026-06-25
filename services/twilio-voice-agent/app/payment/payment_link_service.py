"""
Deterministic payment link send service (v4.26).

Only ``session.confirmed_email`` may be used for outbound payment email.
The LLM cannot pass email arguments through this path.
"""
from __future__ import annotations

import json
import logging
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

PAYMENT_SUCCESS_MESSAGE = (
    "I sent the secure payment link to your email. "
    "Please check your inbox and spam folder. "
    "When you open the link, you can complete the order and enter the "
    "facility and inmate details there."
)
PAYMENT_FAILURE_MESSAGE = (
    "I'm sorry, I could not send the payment link right now. "
    "I can try again or forward this to customer service."
)
PAYMENT_PROGRESS_MESSAGE = "I'm preparing the secure payment link now."


def _cart_item_count(session: "SessionState") -> int:
    try:
        from ..cart.session import get_ledger

        return get_ledger(session).confirmed_count()
    except Exception:  # noqa: BLE001
        items = getattr(session, "cart_items", None) or []
        return len(items)


def _cart_has_items(session: "SessionState") -> bool:
    return _cart_item_count(session) > 0


def _resend_configured() -> bool:
    try:
        from ..config import get_settings

        s = get_settings()
        return bool(s.RESEND_API_KEY and s.RESEND_FROM_EMAIL)
    except Exception:  # noqa: BLE001
        return False


async def send_confirmed_payment_link(
    session: "SessionState",
    *,
    items: list[dict] | None = None,
) -> dict[str, Any]:
    """
    Create or reuse checkout and email the payment link via Resend.

    Reads ``session.confirmed_email`` only — never tool/LLM email args.
    """
    from ..agent_runtime.payment_flow_state import build_payment_tool_result
    from ..payment.email_state import (
        assert_ready_for_payment_send,
        get_canonical_confirmed_email,
        log_payment_flow_diagnostics,
    )
    from ..tools import shopify_tools as st

    sid = (session.call_sid or "")[:6]
    log_payment_flow_diagnostics(session, stage="payment_link_service_start")

    if not _cart_has_items(session):
        logger.error("payment_send_blocked sid=%s reason=empty_cart", sid)
        session.last_payment_attempt_status = "blocked"
        return build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=(
                "I need to confirm the book before I can send a payment link. "
                "Which book would you like to order?"
            ),
            error_code="empty_cart",
            retryable=True,
        )

    if not assert_ready_for_payment_send(session, stage="payment_link_service"):
        return build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=(
                "I need a confirmed email address to send the payment link. "
                "What email should I use?"
            ),
            error_code="email_unconfirmed",
            retryable=True,
        )

    confirmed_email = get_canonical_confirmed_email(session)
    if not confirmed_email:
        logger.error("payment_send_blocked sid=%s reason=email_unconfirmed", sid)
        return build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=(
                "I need a confirmed email address to send the payment link. "
                "What email should I use?"
            ),
            error_code="email_unconfirmed",
            retryable=True,
        )

    if items is None:
        from ..cart.session import get_ledger
        from .payment_destination_groups import group_checkout_items

        items = group_checkout_items(session) or get_ledger(session).to_checkout_items()

    session.payment_send_in_progress = True
    session.email_send_attempted = True
    session.last_payment_attempt_status = "attempting"
    logger.info("payment_auto_send_started sid=%s", sid)

    checkout_url = (
        getattr(session, "checkout_url", "")
        or getattr(session, "pending_checkout_url", "")
    ).strip()
    if checkout_url:
        logger.info(
            "payment_checkout_ready sid=%s cart_item_count=%d",
            sid,
            _cart_item_count(session),
        )

    if not _resend_configured():
        logger.error("payment_send_blocked sid=%s reason=resend_not_configured", sid)
        session.payment_send_in_progress = False
        session.last_payment_attempt_status = "blocked"
        return build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=PAYMENT_FAILURE_MESSAGE,
            error_code="resend_not_configured",
            retryable=True,
            escalation_recommended=True,
        )

    raw = await st.SendPaymentLink(
        items=items,
        email=confirmed_email,
        customer_name=getattr(session, "caller_name", "") or None,
        session=session,
    )
    result = json.loads(raw)
    session.payment_send_in_progress = False

    checkout_after = (
        getattr(session, "checkout_url", "")
        or getattr(session, "pending_checkout_url", "")
    )
    if checkout_after:
        logger.info(
            "payment_checkout_ready sid=%s cart_item_count=%d",
            sid,
            _cart_item_count(session),
        )

    if result.get("success") and result.get("email_sent"):
        session.email_send_success = True
        session.payment_link_sent = True
        session.last_payment_attempt_status = "success"
        session.payment_flow_status = "payment_sent"
        from .payment_destination_groups import (
            mark_active_group_sent,
            pending_groups_remain,
            send_summary_for_active_group,
            advance_to_next_payment_group,
            next_group_engagement_prompt,
        )

        summary = ""
        if getattr(session, "multi_email_payment_active", False):
            summary = send_summary_for_active_group(session)
        mark_active_group_sent(session, checkout_url=checkout_after or "")
        customer_message = result.get("customer_message") or PAYMENT_SUCCESS_MESSAGE
        if getattr(session, "multi_email_payment_active", False):
            if pending_groups_remain(session):
                advance_to_next_payment_group(session)
            engage = next_group_engagement_prompt(session) or ""
            if summary:
                customer_message = f"{summary} {customer_message}"
            if engage:
                customer_message = f"{customer_message} {engage}"
        logger.info(
            "payment_email_send_result sid=%s email_sent=true provider=resend",
            sid,
        )
        logger.info("payment_auto_send_complete sid=%s success=true", sid)
        return build_payment_tool_result(
            success=True,
            email_sent=True,
            customer_message=customer_message,
        )

    session.email_send_success = False
    session.payment_link_sent = False
    session.last_payment_attempt_status = "failed"
    logger.info(
        "payment_email_send_result sid=%s email_sent=false provider=resend",
        sid,
    )
    logger.info("payment_auto_send_complete sid=%s success=false", sid)
    return build_payment_tool_result(
        success=False,
        email_sent=False,
        customer_message=result.get("customer_message") or PAYMENT_FAILURE_MESSAGE,
        error_code=result.get("error_code") or "email_send_failed",
        retryable=True,
        escalation_recommended=True,
    )
