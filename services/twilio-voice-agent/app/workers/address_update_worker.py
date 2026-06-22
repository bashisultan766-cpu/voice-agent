"""AddressUpdateWorker — provides address change instructions."""
from __future__ import annotations
import time
from .base import WorkerResult


class AddressUpdateWorker:
    name = "address_update"

    async def run(self, session, entities, settings) -> WorkerResult:
        t0 = time.monotonic()
        order = entities.get("order_number", "") or session.last_order_number or ""
        support_email = getattr(settings, "SUPPORT_EMAIL", "") or "support@sureshotbooks.com"
        order_ref = f" for order {order}" if order else ""
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={"support_email": support_email, "order_number": order},
            safe_summary=(
                f"For address updates{order_ref}, please email us at {support_email} "
                "with your order number and the correct new address."
            ),
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
