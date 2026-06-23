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

from ..cart.candidate import extract_variant_from_shopify_result, persist_worker_product_result
from ..catalog.query_specificity import is_generic_product_query, score_product_query_specificity
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

        intent = entities.get("intent", "product_search")
        gate_ok = bool(getattr(session, "last_action_gate_approved", True))
        if not gate_ok:
            logger.info(
                "product_search_blocked action_gate sid=%s query=%r",
                session.call_sid[:6], query[:60],
            )
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"results": [], "query": query, "blocked": True, "reason": "action_gate"},
                safe_summary="",
                latency_ms=0,
                source="local",
            )

        if is_generic_product_query(query):
            logger.info(
                "product_search_blocked generic query=%r intent=%s sid=%s",
                query[:60], intent, session.call_sid[:6],
            )
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"results": [], "query": query, "blocked": True},
                safe_summary="",
                latency_ms=0,
                source="local",
            )

        spec = score_product_query_specificity(query)
        if not spec.is_searchable:
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"results": [], "query": query, "blocked": True},
                safe_summary="",
                latency_ms=0,
                source="local",
            )

        t0 = time.monotonic()
        try:
            from ..sync.repositories import ProductCache
            cache = ProductCache()

            # 1. Title exact match
            product = await cache.get_by_title(query)
            if product:
                return _from_cached(product, "cache", t0, session, entities)

            # 2. Handle match
            product = await cache.get_by_handle(_to_handle(query))
            if product:
                return _from_cached(product, "cache", t0, session, entities)

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
            product_id, variant_id = extract_variant_from_shopify_result(top)
            data = {
                "title": top.get("title", ""),
                "price": top.get("price", "N/A"),
                "available": top.get("available", False),
                "product_id": product_id,
                "variant_id": variant_id,
                "query": query,
            }
            if variant_id and top.get("title") and spec.may_save_candidate and gate_ok:
                persist_worker_product_result(
                    session, data,
                    isbn=entities.get("isbn", ""),
                    source="search",
                    source_intent=entities.get("intent", "product_search"),
                    source_query=query,
                    action_gate_approved=gate_ok,
                )
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
                data={**data, "results": safe_results, "count": count},
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


def _from_cached(product, source: str, t0: float, session=None, entities=None) -> WorkerResult:
    avail = "in stock" if product.available else "out of stock"
    data = {
        "title": product.title,
        "price": product.price,
        "available": product.available,
        "author": product.author,
        "variant_id": product.variant_id,
        "product_id": getattr(product, "product_id", "") or "",
    }
    if session is not None and product.variant_id:
        ents = entities or {}
        gate_ok = bool(getattr(session, "last_action_gate_approved", True))
        spec = score_product_query_specificity(
            ents.get("product_phrase", "") or product.title,
        )
        if spec.may_save_candidate and gate_ok:
            persist_worker_product_result(
                session, data, source="search",
                source_intent=ents.get("intent", "product_search"),
                source_query=ents.get("product_phrase", "") or product.title,
                action_gate_approved=gate_ok,
            )
    return WorkerResult(
        worker_name="product_search",
        success=True,
        data=data,
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
