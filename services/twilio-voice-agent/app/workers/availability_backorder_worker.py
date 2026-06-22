"""AvailabilityBackorderWorker — checks product availability and backorder status."""
from __future__ import annotations
import time
from .base import WorkerResult


class AvailabilityBackorderWorker:
    name = "availability_backorder"

    async def run(self, session, entities, settings) -> WorkerResult:
        t0 = time.monotonic()
        product_id = session.last_product_id or entities.get("product_id", "")
        if not product_id:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_product_id",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
        try:
            from ..sync.repositories import ProductCache
            pc = ProductCache()
            product = await pc.get_by_id(product_id)
            if not product:
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={"available": False, "status": "not_found"},
                    safe_summary="That book is not available in our current inventory.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="cache",
                )
            status = "in_stock" if product.available else "out_of_stock"
            summary = (
                f"'{product.title}' is currently in stock."
                if product.available
                else f"'{product.title}' is currently not in stock."
            )
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"available": product.available, "status": status, "title": product.title},
                safe_summary=summary,
                latency_ms=(time.monotonic() - t0) * 1000,
                source="cache",
            )
        except Exception:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
