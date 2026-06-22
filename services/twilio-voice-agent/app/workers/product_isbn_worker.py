"""
ProductISBNWorker — finds a product by ISBN.

Cache-first: checks ProductCache.get_by_isbn() before calling Shopify.
Falls back to Shopify barcode/variant search on cache miss.
Never calls OpenAI or run_agent_turn.
"""
from __future__ import annotations

import json
import logging
import time
from typing import TYPE_CHECKING

from ..cart.candidate import extract_variant_from_shopify_result, persist_worker_product_result, save_product_not_found
from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


class ProductISBNWorker:
    name = "product_isbn"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        isbn = entities.get("isbn", "").strip()
        if not isbn:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_isbn",
                source="none",
            )

        t0 = time.monotonic()
        try:
            # 1. Check ProductCache first
            from ..sync.repositories import ProductCache
            cache = ProductCache()
            product = await cache.get_by_isbn(isbn)
            if product:
                data = {
                    "title": product.title,
                    "author": product.author,
                    "price": product.price,
                    "available": product.available,
                    "variant_id": product.variant_id,
                    "product_id": getattr(product, "product_id", "") or "",
                    "isbn": isbn,
                }
                persist_worker_product_result(session, data, isbn=isbn, source="isbn_search")
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data=data,
                    safe_summary=(
                        f"Found '{product.title}'"
                        + (f" by {product.author}" if product.author else "")
                        + f", {'in stock' if product.available else 'out of stock'}"
                        + (f", ${product.price}" if product.price else "")
                        + "."
                    ),
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="cache",
                )

            # 2. Shopify fallback
            from ..tools.shopify_tools import search_products
            result_json = await search_products(isbn)
            result = json.loads(result_json)
            if result.get("error"):
                return WorkerResult(
                    worker_name=self.name,
                    success=False,
                    error_code="shopify_error",
                    safe_summary="Shopify search is temporarily unavailable.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="shopify",
                )
            results = result.get("results", [])
            count = result.get("count", 0)
            if count == 0:
                save_product_not_found(session, isbn)
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={"results": [], "isbn": isbn},
                    safe_summary=f"No products found for ISBN {isbn}.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="shopify",
                )
            top = results[0]
            product_id, variant_id = extract_variant_from_shopify_result(top)
            data = {
                "title": top.get("title", ""),
                "price": top.get("price", "N/A"),
                "available": top.get("available", False),
                "isbn": isbn,
                "count": count,
                "product_id": product_id,
                "variant_id": variant_id,
            }
            persist_worker_product_result(session, data, isbn=isbn, source="isbn_search")
            avail = "in stock" if top.get("available") else "out of stock"
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data=data,
                safe_summary=(
                    f"Found '{top.get('title', 'Unknown')}'"
                    + f", {avail}"
                    + (f", ${top.get('price', 'N/A')}" if top.get("price") else "")
                    + "."
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="shopify",
            )
        except Exception:
            logger.exception("ProductISBNWorker error isbn=%s sid=%s", isbn, session.call_sid[:6])
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                safe_summary="Could not look up that ISBN right now.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
