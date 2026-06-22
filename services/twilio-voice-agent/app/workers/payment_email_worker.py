"""
PaymentEmailWorker — sends a payment link via Resend.

Security rules (v4.1):
- MUST use session.confirmed_email only — never pending_email or session.caller_email.
- If confirmed_email is empty, refuses to send and prompts caller to confirm email.
- Prevents duplicate sends within the same call.
- Does NOT call OpenAI. Calls tools.email_sender directly.
- Never logs full email addresses.
"""
from __future__ import annotations

import logging
import re
import time
from typing import TYPE_CHECKING

from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


def _mask_email(email: str) -> str:
    """Return masked email: a***@example.com. Safe for logs."""
    if not email or "@" not in email:
        return "***@***"
    local, domain = email.split("@", 1)
    if len(local) <= 1:
        return f"***@{domain}"
    return f"{local[0]}***@{domain}"


class PaymentEmailWorker:
    name = "payment_email"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        t0 = time.monotonic()

        # v4.1: MUST use confirmed_email only.
        # Never fall back to caller_email or a pending (unconfirmed) email.
        confirmed_email = getattr(session, "confirmed_email", "")
        if not confirmed_email:
            pending = getattr(session, "pending_email", "")
            if pending:
                return WorkerResult(
                    worker_name=self.name,
                    success=False,
                    error_code="email_unconfirmed",
                    safe_summary=(
                        "I have an email address on file but it hasn't been confirmed yet. "
                        "Is that email correct? Please say yes or no."
                    ),
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="none",
                )
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_confirmed_email",
                safe_summary=(
                    "I need a confirmed email address to send the payment link. "
                    "Could you give me your email address?"
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )

        email = confirmed_email

        if not session.pending_checkout_url:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_checkout_url",
                safe_summary="No payment link has been created yet.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )

        # Duplicate send guard
        if email in session.payment_email_sent_to:
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"duplicate": True},
                safe_summary="The payment link was already sent to that email this call.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        try:
            from ..tools.email_sender import send_payment_link_email
            result = await send_payment_link_email(
                email=email,
                checkout_url=session.pending_checkout_url,
                product_summary=session.last_product_title or "your selected items",
                caller_name=session.caller_name or None,
                order_or_draft_id=session.pending_draft_order_id or None,
            )

            if result.get("success") and email not in session.payment_email_sent_to:
                session.payment_email_sent_to.append(email)
                # Update caller_email only if we don't already have one
                if not session.caller_email:
                    session.caller_email = email

            if result.get("success"):
                logger.info(
                    "PaymentEmailWorker sent to %s sid=%s",
                    _mask_email(email),
                    session.call_sid[:6],
                )
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={"sent": True},
                    safe_summary="Payment link sent successfully.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="resend",
                )
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="send_failed",
                safe_summary=result.get("error", "Failed to send the payment link."),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="resend",
            )
        except Exception:
            logger.exception("PaymentEmailWorker error sid=%s", session.call_sid[:6])
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                safe_summary="Could not send the payment email at this time.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
