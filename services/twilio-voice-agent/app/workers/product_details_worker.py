"""ProductDetailsWorker — fetches full product details by ID from session state."""
from __future__ import annotations
import json
import time
from .base import WorkerResult


class ProductDetailsWorker:
    name = "product_details"

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
            from ..tools.shopify_tools import get_product_details
            result = json.loads(await get_product_details(product_id))
            if result.get("found") and result.get("product"):
                p = result["product"]
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={
                        "title": p.get("title", ""),
                        "price": p.get("price", "N/A"),
                        "available": p.get("available", False),
                    },
                    safe_summary=f"'{p.get('title')}' — ${p.get('price', 'N/A')}",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="shopify",
                )
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="not_found",
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
