"""CancellationWorker — checks order cancellation eligibility."""
from __future__ import annotations
import json
import time
from .base import WorkerResult


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
            return WorkerResult(
                worker_name=self.name,
                success=result.get("success", False),
                data=result,
                safe_summary=result.get("message", ""),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="shopify",
            )
        except Exception:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
