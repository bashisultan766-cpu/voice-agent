"""Resend email certification — dry-run and allowlisted real send (v4.15.0)."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..payment.safety import _mask_email
from .certification_config import allow_real_email, get_test_email_allowlist, is_email_allowlisted
from .payment_idempotency import mark_emailed, mark_failed

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)

_EMAIL_SYNTAX = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


@dataclass
class EmailCertificationResult:
    success: bool
    dry_run: bool
    message_id: str = ""
    masked_email: str = ""
    failure_class: str = ""
    safe_message: str = ""
    blocked_reason: str = ""


def classify_resend_error(error: str) -> str:
    lower = (error or "").lower()
    if "invalid" in lower or "syntax" in lower:
        return "invalid_email"
    if "unauthorized" in lower or "api key" in lower:
        return "resend_auth_error"
    if "rate" in lower or "429" in lower:
        return "rate_limited"
    if "timeout" in lower:
        return "network_timeout"
    return "resend_error"


def validate_email_for_certification(email: str, *, confirmed: bool = True) -> EmailCertificationResult:
    if not email or not _EMAIL_SYNTAX.match(email.strip()):
        return EmailCertificationResult(
            success=False,
            dry_run=True,
            failure_class="invalid_email",
            safe_message="That email doesn't look valid. Please say it again.",
            blocked_reason="invalid_syntax",
        )
    if not confirmed:
        return EmailCertificationResult(
            success=False,
            dry_run=True,
            failure_class="unconfirmed_email",
            safe_message="I need to confirm the email before I send the payment link.",
            blocked_reason="unconfirmed",
        )
    masked = _mask_email(email)
    if allow_real_email() and not is_email_allowlisted(email):
        return EmailCertificationResult(
            success=False,
            dry_run=False,
            failure_class="not_allowlisted",
            safe_message=(
                "That email is not on the certification allowlist. "
                "Please use a test email or contact support."
            ),
            blocked_reason="not_allowlisted",
            masked_email=masked,
        )
    return EmailCertificationResult(
        success=True,
        dry_run=not allow_real_email(),
        masked_email=masked,
    )


async def send_payment_email_certified(
    email: str,
    checkout_url: str,
    cart_summary: str,
    *,
    group_id: str = "default",
    caller_name: str | None = None,
    order_or_draft_id: str | None = None,
    idempotency_key: str = "",
    confirmed: bool = True,
) -> EmailCertificationResult:
    """Send or simulate payment email with certification guards."""
    validation = validate_email_for_certification(email, confirmed=confirmed)
    if not validation.success and validation.blocked_reason:
        return validation

    masked = _mask_email(email)
    if not checkout_url:
        return EmailCertificationResult(
            success=False,
            dry_run=True,
            failure_class="missing_checkout",
            safe_message=(
                "I had trouble creating the payment link. I can try again or send this to customer service."
            ),
            masked_email=masked,
        )

    if not allow_real_email():
        message_id = f"dry_run_{group_id}_{masked.split('@')[0]}"
        if idempotency_key:
            mark_emailed(idempotency_key, resend_message_id=message_id)
        logger.info(
            "email_certifier_dry_run group_id=%s masked_email=%s message_id=%s",
            group_id[:8],
            masked,
            message_id[:12],
        )
        return EmailCertificationResult(
            success=True,
            dry_run=True,
            message_id=message_id,
            masked_email=masked,
            safe_message=(
                f"I sent the payment link to {masked}. When you open it, you can enter "
                "the facility and inmate details and complete the order."
            ),
        )

    try:
        from ..config import get_settings
        from ..tools.email_sender import send_payment_link_email

        settings = get_settings()
        if not settings.RESEND_FROM_EMAIL:
            return EmailCertificationResult(
                success=False,
                dry_run=False,
                failure_class="resend_config",
                safe_message=(
                    "I created the payment link, but I had trouble sending the email. "
                    "I can try again or send this to customer service."
                ),
                masked_email=masked,
            )

        result = await send_payment_link_email(
            email=email,
            checkout_url=checkout_url,
            product_summary=cart_summary or "your selected items",
            caller_name=caller_name,
            order_or_draft_id=order_or_draft_id,
        )

        if not result.get("success"):
            failure = classify_resend_error(result.get("error", ""))
            if idempotency_key:
                mark_failed(idempotency_key)
            return EmailCertificationResult(
                success=False,
                dry_run=False,
                failure_class=failure,
                safe_message=(
                    "I created the payment link, but I had trouble sending the email. "
                    "I can try again or send this to customer service."
                ),
                masked_email=masked,
            )

        message_id = str(result.get("id") or result.get("message_id") or "")
        if idempotency_key:
            mark_emailed(idempotency_key, resend_message_id=message_id)
        logger.info(
            "payment_link_email_sent group_id=%s masked_email=%s message_id=%s",
            group_id[:8],
            masked,
            message_id[:8] if message_id else "",
        )
        return EmailCertificationResult(
            success=True,
            dry_run=False,
            message_id=message_id,
            masked_email=masked,
            safe_message=(
                f"I sent the payment link to {masked}. When you open it, you can enter "
                "the facility and inmate details and complete the order."
            ),
        )
    except Exception as exc:
        logger.exception("email_certifier_error group_id=%s masked_email=%s", group_id[:8], masked)
        if idempotency_key:
            mark_failed(idempotency_key)
        return EmailCertificationResult(
            success=False,
            dry_run=False,
            failure_class=classify_resend_error(str(exc)),
            safe_message=(
                "I created the payment link, but I had trouble sending the email. "
                "I can try again or send this to customer service."
            ),
            masked_email=masked,
        )


def payment_sent_safe_message(checkout_ok: bool, email_result: EmailCertificationResult) -> str:
    if not checkout_ok:
        return (
            "I had trouble creating the payment link. I can try again or send this to customer service."
        )
    if not email_result.success:
        return email_result.safe_message or (
            "I created the payment link, but I had trouble sending the email. "
            "I can try again or send this to customer service."
        )
    return email_result.safe_message
