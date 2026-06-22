"""AddressUpdateWorker — address change instructions directing to Jessica (v4.8)."""
from __future__ import annotations
import time
from .base import WorkerResult


class AddressUpdateWorker:
    name = "address_update"

    async def run(self, session, entities, settings) -> WorkerResult:
        t0 = time.monotonic()
        order = entities.get("order_number", "") or session.last_order_number or ""

        # Ask for order number if we don't have one
        if not order:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_order_number",
                safe_summary="What is your order number? I'll need that to direct you for the address update.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )

        # Prefer JESSICA_EMAIL, fall back to SUPPORT_EMAIL or generic
        jessica_email = (
            getattr(settings, "JESSICA_EMAIL", "")
            or getattr(settings, "CUSTOMER_SERVICE_EMAIL", "")
            or getattr(settings, "SUPPORT_EMAIL", "")
            or ""
        )
        order_ref = f" for order {order}" if order else ""

        if jessica_email:
            summary = (
                f"For address updates{order_ref}, please email Jessica at {jessica_email} "
                "with your order number and the correct new address."
            )
        else:
            summary = (
                f"For address updates{order_ref}, please email Jessica "
                "with your order number and the correct address."
            )

        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={"jessica_email": jessica_email, "order_number": order},
            safe_summary=summary,
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
