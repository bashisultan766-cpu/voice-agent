"""
PaymentEmailWorker — sends a payment link via Resend.

Prevents duplicate sends within the same call.
Does not call OpenAI. Calls tools.email_sender directly.
"""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


class PaymentEmailWorker:
    name = "payment_email"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        t0 = time.monotonic()
        email = entities.get("email") or session.caller_email
        if not email:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_email",
                safe_summary="I need an email address to send the payment link.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )

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
                safe_summary=f"The payment link was already sent to that email this call.",
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
                if not session.caller_email:
                    session.caller_email = email

            if result.get("success"):
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
