"""
ProductSearchWorker — finds products by title, author, or search phrase.

Cache-first order:
  1. ProductCache.get_by_title()
  2. ProductCache.get_by_handle()
  3. Shopify live search fallback

Never calls OpenAI or run_agent_turn.
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import TYPE_CHECKING

from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_SPACES = re.compile(r"\s+")


def _to_handle(query: str) -> str:
    """Convert a search phrase to a Shopify-style URL handle."""
    h = query.lower().strip()
    h = re.sub(r"[^\w\s-]", "", h)
    h = _SPACES.sub("-", h)
    return h[:100]


class ProductSearchWorker:
    name = "product_search"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        query = (
            entities.get("product_phrase")
            or entities.get("isbn")
            or ""
        ).strip()
        if not query:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_query",
                source="none",
            )

        t0 = time.monotonic()
        try:
            from ..sync.repositories import ProductCache
            cache = ProductCache()

            # 1. Title exact match
            product = await cache.get_by_title(query)
            if product:
                return _from_cached(product, "cache", t0)

            # 2. Handle match
            product = await cache.get_by_handle(_to_handle(query))
            if product:
                return _from_cached(product, "cache", t0)

            # 3. Shopify live search
            from ..tools.shopify_tools import search_products
            result_json = await search_products(query)
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
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={"results": [], "query": query},
                    safe_summary=f"No products found matching '{query}'.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="shopify",
                )

            top = results[0]
            avail = "in stock" if top.get("available") else "out of stock"
            safe_results = [
                {
                    "title": r.get("title", ""),
                    "price": r.get("price", "N/A"),
                    "available": r.get("available", False),
                }
                for r in results[:3]
            ]
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"results": safe_results, "count": count, "query": query},
                safe_summary=(
                    f"Found {count} result(s) for '{query}'. "
                    f"Top match: '{top.get('title', '')}', {avail}"
                    + (f", ${top.get('price', 'N/A')}" if top.get("price") else "")
                    + "."
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="shopify",
            )
        except Exception:
            logger.exception("ProductSearchWorker error query=%r sid=%s", query, session.call_sid[:6])
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                safe_summary="Product search is temporarily unavailable.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )


def _from_cached(product, source: str, t0: float) -> WorkerResult:
    avail = "in stock" if product.available else "out of stock"
    return WorkerResult(
        worker_name="product_search",
        success=True,
        data={
            "title": product.title,
            "price": product.price,
            "available": product.available,
            "author": product.author,
            "variant_id": product.variant_id,
        },
        safe_summary=(
            f"Found '{product.title}'"
            + (f" by {product.author}" if product.author else "")
            + f", {avail}"
            + (f", ${product.price}" if product.price else "")
            + "."
        ),
        latency_ms=(time.monotonic() - t0) * 1000,
        source=source,
    )
