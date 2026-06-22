"""
PriceInventoryWorker — fetches price and availability for a known product.

Checks ProductCache by ID. If session has last_product_id, uses that.
Cache-first; no LLM calls.
"""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


class PriceInventoryWorker:
    name = "price_inventory"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        product_id = session.last_product_id or entities.get("product_id", "")
        t0 = time.monotonic()

        if not product_id:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_product_id",
                source="none",
            )

        try:
            from ..sync.repositories import ProductCache
            cache = ProductCache()
            product = await cache.get_by_id(product_id)
            if not product:
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={"found": False},
                    safe_summary="Price information not available in local cache.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="cache",
                )
            avail = "in stock" if product.available else "out of stock"
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={
                    "title": product.title,
                    "price": product.price,
                    "currency": product.currency,
                    "available": product.available,
                },
                safe_summary=(
                    f"'{product.title}' is {avail}"
                    + (f" at ${product.price} {product.currency}" if product.price else "")
                    + "."
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="cache",
            )
        except Exception:
            logger.exception("PriceInventoryWorker error sid=%s", session.call_sid[:6])
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
