"""AvailabilityBackorderWorker — checks product availability and backorder status (v4.8)."""
from __future__ import annotations
import logging
import time
from .base import WorkerResult
from ..catalog.stock_overrides import is_out_of_stock_override, apply_stock_override
from ..catalog.availability import (
    AVAILABILITY_BACKORDER,
    AVAILABILITY_OUT_OF_STOCK,
    AVAILABILITY_IN_STOCK,
    AVAILABILITY_UNKNOWN,
    availability_response,
)

logger = logging.getLogger(__name__)

_BACKORDER_RESPONSE = (
    "That book is currently on backorder. "
    "That means it is not available to ship immediately, "
    "but it may be fulfilled once stock is available."
)


class AvailabilityBackorderWorker:
    name = "availability_backorder"

    async def run(self, session, entities, settings) -> WorkerResult:
        t0 = time.monotonic()

        # Title may be provided directly (for override check without product_id)
        title_hint = (
            entities.get("product_phrase")
            or entities.get("book_title")
            or session.last_product_title
            or ""
        )

        # v4.8: client override check (e.g. Red River Vengeance)
        if title_hint and is_out_of_stock_override(title_hint):
            logger.info(
                "availability_backorder_override title=%s status=out_of_stock",
                title_hint[:40],
            )
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={
                    "available": False,
                    "status": AVAILABILITY_OUT_OF_STOCK,
                    "title": title_hint,
                    "override": True,
                    "eligible_for_checkout": False,
                },
                safe_summary=availability_response(AVAILABILITY_OUT_OF_STOCK),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="override",
            )

        product_id = session.last_product_id or entities.get("product_id", "")
        if not product_id and not title_hint:
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
            product = None
            if product_id:
                product = await pc.get_by_id(product_id)
            if product is None and title_hint:
                product = await pc.get_by_title(title_hint)

            if not product:
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={"available": False, "status": AVAILABILITY_UNKNOWN},
                    safe_summary=availability_response(AVAILABILITY_UNKNOWN),
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="cache",
                )

            # Apply client override on top of Shopify data
            available, status = apply_stock_override(product.title, product.available)

            # Check backorder flag if present
            is_backorder = getattr(product, "backorder", False) or False
            if is_backorder and not available:
                status = AVAILABILITY_BACKORDER

            eligible = status == AVAILABILITY_IN_STOCK

            summary = availability_response(status)
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={
                    "available": available,
                    "status": status,
                    "title": product.title,
                    "eligible_for_checkout": eligible,
                },
                safe_summary=summary,
                latency_ms=(time.monotonic() - t0) * 1000,
                source="cache",
            )
        except Exception:
            logger.exception(
                "AvailabilityBackorderWorker error sid=%s", session.call_sid[:6]
            )
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
