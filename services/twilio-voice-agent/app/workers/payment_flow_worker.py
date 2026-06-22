"""
PaymentFlowWorker — end-to-end checkout + email send (v4.3).

Runs only on payment_execute intent after final caller confirmation.
Never calls OpenAI.
"""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from .base import WorkerResult
from .checkout_worker import CheckoutWorker
from .payment_email_worker import PaymentEmailWorker
from .payment_safety_worker import PaymentSafetyWorker

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


def _mask_email(email: str) -> str:
    try:
        from ..caller.repository import mask_email
        return mask_email(email)
    except Exception:
        if "@" in email:
            local, domain = email.split("@", 1)
            return local[:1] + "***@" + domain
        return "***"


class PaymentFlowWorker:
    name = "payment_flow"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        t0 = time.monotonic()
        safety = PaymentSafetyWorker()
        safety_result = await safety.run(session, entities, settings)

        if not safety_result.success:
            missing = (safety_result.data or {}).get("missing", [])
            if "book" in missing:
                return WorkerResult(
                    worker_name=self.name,
                    success=False,
                    error_code="missing_book",
                    data={"missing": missing},
                    safe_summary="Which book would you like to buy?",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="local",
                )
            if "confirmed_email" in missing:
                pending = getattr(session, "pending_email", "")
                if pending:
                    return WorkerResult(
                        worker_name=self.name,
                        success=False,
                        error_code="email_unconfirmed",
                        safe_summary=(
                            f"Just to confirm, I heard {_mask_email(pending)}. Is that correct?"
                        ),
                        latency_ms=(time.monotonic() - t0) * 1000,
                        source="local",
                    )
                return WorkerResult(
                    worker_name=self.name,
                    success=False,
                    error_code="no_email",
                    safe_summary="What email should I send the payment link to?",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="local",
                )

        checkout = CheckoutWorker()
        if not session.pending_checkout_url:
            checkout_result = await checkout.run(session, entities, settings)
            if not checkout_result.success:
                logger.info(
                    "payment_flow checkout_failed sid=%s err=%s",
                    session.call_sid[:6],
                    checkout_result.error_code,
                )
                return WorkerResult(
                    worker_name=self.name,
                    success=False,
                    error_code="checkout_failed",
                    safe_summary=(
                        "I'm having trouble creating the payment link. Let me try one more time."
                    ),
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="shopify",
                )
            if checkout_result.data:
                url = checkout_result.data.get("checkout_url", "")
                if url:
                    session.pending_checkout_url = url

        email_worker = PaymentEmailWorker()
        email_result = await email_worker.run(session, entities, settings)

        if email_result.success:
            session.payment_flow_status = "payment_sent"
            masked = _mask_email(getattr(session, "confirmed_email", ""))
            logger.info(
                "payment_flow sent ok sid=%s to=%s",
                session.call_sid[:6],
                masked,
            )
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"sent": True},
                safe_summary=(
                    "I've sent the payment link to your email. "
                    "Please check your inbox and spam folder."
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="resend",
            )

        if session.pending_checkout_url:
            logger.info(
                "payment_flow email_failed sid=%s err=%s",
                session.call_sid[:6],
                email_result.error_code,
            )
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="email_failed",
                safe_summary=(
                    "I created the payment link, but I could not send the email right now. "
                    "I can try again."
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="resend",
            )

        return WorkerResult(
            worker_name=self.name,
            success=False,
            error_code="payment_failed",
            safe_summary="I could not complete the payment link right now.",
            latency_ms=(time.monotonic() - t0) * 1000,
            source="none",
        )
