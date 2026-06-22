"""
TrackingWorker — returns fulfillment tracking info from OrderCache.

Cache-only: returns tracking_summary stored at sync time.
Does not reveal full tracking URLs or sensitive shipment data.
"""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


class TrackingWorker:
    name = "tracking"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        order_number = entities.get("order_number") or session.last_order_number
        if not order_number:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_order_number",
                source="none",
            )

        t0 = time.monotonic()
        try:
            from ..sync.repositories import OrderCache
            cache = OrderCache()
            order = await cache.get_by_number(order_number)
            if not order:
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={"found": False},
                    safe_summary=f"No tracking info found for {order_number}.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="cache",
                )

            tracking = order.tracking_summary or ""
            fulfillment = order.fulfillment_status or "unfulfilled"
            summary = (
                f"Order {order.order_number} fulfillment: {fulfillment}"
                + (f". {tracking}" if tracking else "")
                + "."
            )
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={
                    "order_number": order.order_number,
                    "fulfillment_status": fulfillment,
                    "tracking_summary": tracking,
                },
                safe_summary=summary,
                latency_ms=(time.monotonic() - t0) * 1000,
                source="cache",
            )
        except Exception:
            logger.exception("TrackingWorker error order=%s sid=%s", order_number, session.call_sid[:6])
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
