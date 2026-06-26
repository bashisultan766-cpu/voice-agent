"""
UniversalCatalogSearchWorker — search Shopify for any catalog item (v4.14.7).

Supports books, newspapers, magazines, subscriptions, and general products.
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import TYPE_CHECKING, Any

from ..cart.candidate import extract_variant_from_shopify_result, persist_worker_product_result
from ..catalog.query_specificity import score_product_query_specificity
from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_SPACES = re.compile(r"\s+")


def _to_handle(query: str) -> str:
    h = query.lower().strip()
    h = re.sub(r"[^\w\s-]", "", h)
    h = _SPACES.sub("-", h)
    return h[:100]


def _normalize_row(row: dict[str, Any], *, strategy: str) -> dict[str, Any]:
    from ..agent_runtime.catalog_orderability import assess_orderability

    product_id, variant_id = extract_variant_from_shopify_result(row)
    tags = row.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    base = {
        "title": row.get("title") or row.get("product_title") or "",
        "price": row.get("price") or "N/A",
        "available": row.get("available", False),
        "product_id": product_id,
        "variant_id": variant_id,
        "product_type": row.get("product_type") or row.get("productType") or "",
        "vendor": row.get("vendor") or "",
        "handle": row.get("handle") or "",
        "tags": tags,
        "inventory_quantity": row.get("inventory") or row.get("inventory_quantity"),
        "status": row.get("status") or "ACTIVE",
        "published": row.get("published"),
        "online_store_visible": row.get("online_store_visible"),
        "_search_strategy": strategy,
    }
    base.update(assess_orderability(base))
    return base


def _rank_results(
    results: list[dict[str, Any]],
    *,
    publication_title: str,
    product_kind: str,
    delivery_frequency: str,
    subscription_term: str,
) -> list[dict[str, Any]]:
    title_q = (publication_title or "").lower()
    kind = (product_kind or "").lower()
    freq = (delivery_frequency or "").lower()
    term = (subscription_term or "").lower()

    def score(row: dict[str, Any]) -> float:
        s = 0.0
        t = (row.get("title") or "").lower()
        ptype = (row.get("product_type") or "").lower()
        tags = " ".join(row.get("tags") or []).lower()
        if title_q and title_q == t:
            s += 1.0
        elif title_q and title_q in t:
            s += 0.85
        if kind and kind in ptype:
            s += 0.3
        if kind and kind in tags:
            s += 0.2
        if freq and freq in t:
            s += 0.15
        if term and term.replace(" ", "") in t.replace(" ", ""):
            s += 0.15
        if row.get("available"):
            s += 0.05
        if row.get("can_add_to_cart"):
            s += 0.10
        return s

    ranked = sorted(results, key=score, reverse=True)
    orderable = [r for r in ranked if r.get("can_add_to_cart")]
    return orderable + [r for r in ranked if not r.get("can_add_to_cart")]


class UniversalCatalogSearchWorker:
    name = "universal_catalog_search"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        sid = session.call_sid[:6]
        product_kind = (entities.get("product_kind") or "product").strip()
        publication_title = (entities.get("publication_title") or entities.get("title") or "").strip()
        product_phrase = (entities.get("product_phrase") or publication_title or "").strip()
        isbn = (entities.get("isbn") or "").strip()
        sku = (entities.get("sku") or "").strip()
        product_type = (entities.get("product_type") or product_kind or "").strip()
        collection_hint = (entities.get("collection_hint") or "").strip()
        delivery_frequency = (entities.get("delivery_frequency") or "").strip()
        subscription_term = (entities.get("subscription_term") or entities.get("term") or "").strip()
        tags_hint = (entities.get("tags") or publication_title or product_kind).strip()

        query = product_phrase or publication_title or isbn or sku
        if not query:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_query",
                source="none",
            )

        logger.info(
            "universal_catalog_search_started sid=%s kind=%s query=%r",
            sid, product_kind, query[:80],
        )

        gate_ok = bool(getattr(session, "last_action_gate_approved", True))
        if not gate_ok:
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"results": [], "query": query, "blocked": True},
                source="local",
            )

        spec = score_product_query_specificity(query)
        if not spec.is_searchable and not publication_title:
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"results": [], "query": query, "blocked": True},
                source="local",
            )

        t0 = time.monotonic()
        strategy_counts: dict[str, int] = {}
        merged: list[dict[str, Any]] = []
        seen_keys: set[str] = set()

        def _add(rows: list[dict], strategy: str) -> None:
            strategy_counts[strategy] = len(rows)
            logger.info("shopify_search_strategy sid=%s strategy=%s count=%d", sid, strategy, len(rows))
            for row in rows:
                norm = _normalize_row(row, strategy=strategy)
                key = norm.get("variant_id") or norm.get("product_id") or norm.get("title", "")
                if key and key not in seen_keys:
                    seen_keys.add(key)
                    merged.append(norm)

        try:
            from ..sync.repositories import ProductCache
            from ..tools.shopify_tools import search_products

            cache = ProductCache()

            if isbn:
                product = await cache.get_by_isbn(isbn)
                if product:
                    _add([{
                        "title": product.title,
                        "price": product.price,
                        "available": product.available,
                        "variant_id": product.variant_id,
                        "product_id": getattr(product, "product_id", ""),
                    }], "isbn_cache")
                else:
                    result_json = await search_products(isbn, limit=5)
                    result = json.loads(result_json)
                    _add(result.get("results", []), "isbn_shopify")

            if publication_title and not merged:
                product = await cache.get_by_title(publication_title)
                if product:
                    _add([{
                        "title": product.title,
                        "price": product.price,
                        "available": product.available,
                        "variant_id": product.variant_id,
                        "product_id": getattr(product, "product_id", ""),
                    }], "exact_title_cache")
                else:
                    result_json = await search_products(publication_title, limit=5)
                    result = json.loads(result_json)
                    _add(result.get("results", []), "exact_title")

            if publication_title and len(merged) < 3:
                result_json = await search_products(f"title:*{publication_title}*", limit=5)
                result = json.loads(result_json)
                _add(result.get("results", []), "title_contains")

            if product_type and len(merged) < 3:
                result_json = await search_products(f"product_type:{product_type}", limit=5)
                result = json.loads(result_json)
                _add(result.get("results", []), f"product_type_{product_type}")

            if tags_hint and len(merged) < 3:
                result_json = await search_products(f"tag:{tags_hint}", limit=5)
                result = json.loads(result_json)
                _add(result.get("results", []), "tags")

            if collection_hint and len(merged) < 3:
                handle = _to_handle(collection_hint)
                product = await cache.get_by_handle(handle)
                if product:
                    _add([{
                        "title": product.title,
                        "price": product.price,
                        "available": product.available,
                        "variant_id": product.variant_id,
                        "product_id": getattr(product, "product_id", ""),
                    }], "collection_handle")
                result_json = await search_products(collection_hint, limit=5)
                result = json.loads(result_json)
                _add(result.get("results", []), "collection_search")

            if product_phrase and len(merged) < 3:
                result_json = await search_products(product_phrase, limit=5)
                result = json.loads(result_json)
                _add(result.get("results", []), "broad_fallback")

            active_orderable = [m for m in merged if m.get("can_add_to_cart") and (m.get("status") or "ACTIVE").upper() == "ACTIVE"]
            if not active_orderable and (publication_title or product_phrase):
                from ..integrations.shopify_catalog_scanner import deep_search_term, scanned_product_to_search_row

                deep_term = publication_title or product_phrase
                logger.info("shopify_deep_scan_started sid=%s query=%r", sid, deep_term[:60])
                deep_products = await deep_search_term(deep_term, include_all_statuses=True)
                deep_rows = [scanned_product_to_search_row(p) for p in deep_products]
                _add(deep_rows, "deep_scan_all_statuses")
                strategy_counts["deep_scan_all_statuses"] = len(deep_rows)

            merged = _rank_results(
                merged,
                publication_title=publication_title,
                product_kind=product_kind,
                delivery_frequency=delivery_frequency,
                subscription_term=subscription_term,
            )

            logger.info(
                "universal_catalog_search_completed sid=%s candidates=%d strategies=%s",
                sid, len(merged), strategy_counts,
            )

            if not merged:
                for strategy, count in strategy_counts.items():
                    logger.info("shopify_search_result sid=%s strategy=%s count=%d", sid, strategy, count)
                from ..agent_runtime.catalog_coverage_diagnostics import diagnose_catalog_visibility

                diag = await diagnose_catalog_visibility(publication_title or query)
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={
                        "results": [],
                        "query": query,
                        "product_kind": product_kind,
                        "publication_title": publication_title,
                        "strategy_counts": strategy_counts,
                        "not_found": True,
                        "diagnostics": diag.to_dict(),
                        "diagnostics_summary": diag.likely_issue,
                    },
                    safe_summary=f"No store data match for {publication_title or query}.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="shopify",
                )

            top = merged[0]
            if top.get("can_add_to_cart") and top.get("variant_id") and spec.may_save_candidate and gate_ok:
                persist_worker_product_result(
                    session,
                    top,
                    isbn=isbn,
                    source="universal_catalog_search",
                    source_intent=entities.get("intent", "catalog_product_search"),
                    source_query=query,
                    action_gate_approved=gate_ok,
                )

            safe_results = merged[:5]
            if not top.get("can_add_to_cart"):
                reason = top.get("unavailable_reason") or "not checkout-ready"
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={
                        **top,
                        "results": safe_results,
                        "count": len(merged),
                        "query": query,
                        "product_kind": product_kind,
                        "publication_title": publication_title,
                        "strategy_counts": strategy_counts,
                        "not_orderable": True,
                        "unavailable_reason": reason,
                    },
                    safe_summary=(
                        f"Found '{top.get('title', '')}' in store data but not checkout-ready: {reason}"
                    ),
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="shopify",
                )

            avail = "in stock" if top.get("available") else "out of stock"
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={
                    **top,
                    "results": safe_results,
                    "count": len(merged),
                    "query": query,
                    "product_kind": product_kind,
                    "publication_title": publication_title,
                    "strategy_counts": strategy_counts,
                },
                safe_summary=(
                    f"Found {len(merged)} result(s) for '{publication_title or query}'. "
                    f"Top: '{top.get('title', '')}', {avail}."
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="shopify",
            )
        except Exception:
            logger.exception(
                "UniversalCatalogSearchWorker error sid=%s query=%r",
                sid, query[:60],
            )
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                safe_summary="Catalog search is temporarily unavailable.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
