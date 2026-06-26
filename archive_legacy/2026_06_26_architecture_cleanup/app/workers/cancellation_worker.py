"""CancellationWorker — checks order cancellation eligibility (v4.8)."""
from __future__ import annotations
import json
import logging
import time
from .base import WorkerResult

logger = logging.getLogger(__name__)


class CancellationWorker:
    name = "cancellation"

    async def run(self, session, entities, settings) -> WorkerResult:
        t0 = time.monotonic()
        order_number = entities.get("order_number", "") or session.last_order_number or ""
        if not order_number:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_order_number",
                safe_summary="What is the order number you'd like to cancel?",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
        try:
            from ..tools.shopify_tools import CancelOrderRequest
            result = json.loads(await CancelOrderRequest(
                order_number=order_number, session=session,
            ))

            if not result.get("found", True) and not result.get("success"):
                return WorkerResult(
                    worker_name=self.name,
                    success=False,
                    error_code="not_found",
                    safe_summary=f"I couldn't find order {order_number}. Please double-check the order number.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="shopify",
                )

            ful = (result.get("fulfillment_status") or "").upper()
            status = (result.get("status") or "").upper()

            if ful in ("FULFILLED", "PARTIALLY_FULFILLED"):
                msg = (
                    "This order has already shipped, so it cannot be cancelled from here. "
                    "I can forward this to customer service for the next step."
                )
            elif status in ("REFUNDED", "VOIDED"):
                msg = f"This order already shows as {status.lower()}."
            elif result.get("cancellation_eligible"):
                msg = (
                    "This order may be eligible for cancellation since it has not yet shipped. "
                    "Customer service can process the cancellation request."
                )
            else:
                msg = result.get("message") or (
                    "I don't want to give you the wrong answer. "
                    "I can forward this to customer service for review."
                )

            return WorkerResult(
                worker_name=self.name,
                success=result.get("success", False),
                data=result,
                safe_summary=msg,
                latency_ms=(time.monotonic() - t0) * 1000,
                source="shopify",
            )
        except Exception:
            logger.exception("CancellationWorker error sid=%s", session.call_sid[:6])
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                safe_summary=(
                    "I don't want to give you the wrong answer. "
                    "I can forward this to customer service for review."
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
