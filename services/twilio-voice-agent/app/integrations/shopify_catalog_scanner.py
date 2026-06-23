"""Deep Shopify Admin API catalog scanner (v4.14.8)."""
from __future__ import annotations

import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_SEARCH_TERMS = (
    "USA Today",
    "newspaper",
    "news paper",
    "paper",
    "magazine",
    "subscription",
    "Wall Street Journal",
    "New York Times",
    "Times",
    "monthly",
    "3 months",
    "6 months",
    "5 day",
    "7 day",
)

STATUS_QUERIES = ("status:active", "status:draft", "status:archived")

_SECRET_PATTERNS = (
    re.compile(r"shpat_[a-zA-Z0-9]+"),
    re.compile(r"shpca_[a-zA-Z0-9]+"),
    re.compile(r"X-Shopify-Access-Token:\s*\S+", re.I),
)


@dataclass
class ScannedVariant:
    id: str
    title: str
    sku: str
    price: str
    available_for_sale: bool
    inventory_quantity: int | None
    inventory_policy: str | None = None


@dataclass
class ScannedProduct:
    product_id: str
    title: str
    handle: str
    status: str
    product_type: str
    vendor: str
    tags: list[str]
    online_store_url: str
    published_at: str | None
    published_online: bool
    publications: list[str]
    variants: list[ScannedVariant]
    metafields: list[dict[str, str]] = field(default_factory=list)
    match_source: str = ""
    match_term: str = ""
    usability: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        best = self.best_variant()
        return {
            "product_id": self.product_id,
            "title": self.title,
            "handle": self.handle,
            "status": self.status,
            "product_type": self.product_type,
            "vendor": self.vendor,
            "tags": self.tags,
            "online_store_url": self.online_store_url,
            "published_at": self.published_at,
            "published_online": self.published_online,
            "publications": self.publications,
            "match_source": self.match_source,
            "match_term": self.match_term,
            "variants": [
                {
                    "id": v.id,
                    "title": v.title,
                    "sku": v.sku,
                    "price": v.price,
                    "available_for_sale": v.available_for_sale,
                    "inventory_quantity": v.inventory_quantity,
                }
                for v in self.variants
            ],
            "best_variant_id": best.id if best else "",
            "best_price": best.price if best else "",
            "usability": self.usability,
        }

    def best_variant(self) -> ScannedVariant | None:
        for v in self.variants:
            if v.available_for_sale and v.id:
                return v
        return self.variants[0] if self.variants else None


@dataclass
class CatalogScanReport:
    store_masked: str
    configured: bool
    products_by_status: dict[str, int]
    visible_active_count: int
    count_by_product_type: dict[str, int]
    count_by_vendor: dict[str, int]
    top_tags: list[tuple[str, int]]
    collection_names: list[str]
    matched_products: list[ScannedProduct]
    search_term_hits: dict[str, int]
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "store_masked": self.store_masked,
            "configured": self.configured,
            "products_by_status": self.products_by_status,
            "visible_active_count": self.visible_active_count,
            "count_by_product_type": self.count_by_product_type,
            "count_by_vendor": self.count_by_vendor,
            "top_tags": self.top_tags,
            "collection_names": self.collection_names,
            "matched_products": [p.to_dict() for p in self.matched_products],
            "search_term_hits": self.search_term_hits,
            "errors": self.errors,
        }


def mask_secrets(text: str) -> str:
    out = text or ""
    for pat in _SECRET_PATTERNS:
        out = pat.sub("***", out)
    return out


def assess_voice_agent_usability(product: ScannedProduct) -> dict[str, Any]:
    """Explain why a scanned product is or is not usable by the voice agent."""
    best = product.best_variant()
    issues: list[str] = []
    usable = True

    if product.status != "ACTIVE":
        usable = False
        issues.append(f"status is {product.status}, not ACTIVE")
    if not product.published_online and not product.online_store_url:
        usable = False
        issues.append("not published to online store / no onlineStoreUrl")
    if not best:
        usable = False
        issues.append("no variants found")
    elif not best.id:
        usable = False
        issues.append("variant missing id (no checkout variant_id)")
    elif not best.price or best.price in ("0", "0.00"):
        usable = False
        issues.append("variant missing price")
    elif not best.available_for_sale:
        issues.append("variant not availableForSale (may still display but not checkout-ready)")
    if not product.product_type:
        issues.append("product_type missing — harder for catalog taxonomy routing")
    if not product.tags:
        issues.append("tags missing — harder for newspaper/magazine search")

    summary = "usable for voice checkout" if usable and not issues else "; ".join(issues) or "review manually"
    return {
        "voice_agent_usable": usable and best is not None and bool(best.id),
        "can_add_to_cart": usable and bool(best and best.available_for_sale and best.id),
        "issues": issues,
        "summary": summary,
    }


def _parse_variants(edges: list[dict]) -> list[ScannedVariant]:
    out: list[ScannedVariant] = []
    for e in edges or []:
        node = e.get("node") or {}
        inv = node.get("inventoryQuantity")
        out.append(ScannedVariant(
            id=str(node.get("id") or ""),
            title=str(node.get("title") or ""),
            sku=str(node.get("sku") or ""),
            price=str(node.get("price") or ""),
            available_for_sale=bool(node.get("availableForSale")),
            inventory_quantity=int(inv) if inv is not None else None,
            inventory_policy=str(node.get("inventoryPolicy") or "") or None,
        ))
    return out


def _parse_publications(node: dict) -> tuple[bool, list[str]]:
    pubs: list[str] = []
    published_online = bool(node.get("onlineStoreUrl"))
    for e in (node.get("resourcePublicationsV2") or {}).get("edges") or []:
        pn = (e.get("node") or {})
        pub = (pn.get("publication") or {})
        name = str(pub.get("name") or "")
        if name:
            pubs.append(name)
        if pn.get("isPublished") and "online" in name.lower():
            published_online = True
    if node.get("publishedAt"):
        published_online = True
    return published_online, pubs


def _node_to_product(node: dict, *, match_source: str, match_term: str) -> ScannedProduct:
    tags_raw = node.get("tags") or []
    if isinstance(tags_raw, str):
        tags = [t.strip() for t in tags_raw.split(",") if t.strip()]
    else:
        tags = list(tags_raw)
    published_online, pubs = _parse_publications(node)
    metafields = [
        {
            "namespace": (m.get("node") or {}).get("namespace", ""),
            "key": (m.get("node") or {}).get("key", ""),
            "value": str((m.get("node") or {}).get("value") or "")[:120],
        }
        for m in (node.get("metafields") or {}).get("edges") or []
    ]
    product = ScannedProduct(
        product_id=str(node.get("id") or ""),
        title=str(node.get("title") or ""),
        handle=str(node.get("handle") or ""),
        status=str(node.get("status") or "UNKNOWN").upper(),
        product_type=str(node.get("productType") or ""),
        vendor=str(node.get("vendor") or ""),
        tags=tags,
        online_store_url=str(node.get("onlineStoreUrl") or ""),
        published_at=node.get("publishedAt"),
        published_online=published_online,
        publications=pubs,
        variants=_parse_variants((node.get("variants") or {}).get("edges") or []),
        metafields=metafields,
        match_source=match_source,
        match_term=match_term,
    )
    product.usability = assess_voice_agent_usability(product)
    return product


def scanned_product_to_search_row(product: ScannedProduct) -> dict[str, Any]:
    """Convert ScannedProduct to universal search worker row dict."""
    from ..agent_runtime.catalog_orderability import assess_orderability

    best = product.best_variant()
    row = {
        "title": product.title,
        "handle": product.handle,
        "product_id": product.product_id,
        "variant_id": best.id if best else "",
        "price": best.price if best else "",
        "available": best.available_for_sale if best else False,
        "inventory_quantity": best.inventory_quantity if best else None,
        "product_type": product.product_type,
        "vendor": product.vendor,
        "tags": product.tags,
        "status": product.status,
        "published": product.published_online,
        "online_store_visible": bool(product.online_store_url) or product.published_online,
        "online_store_url": product.online_store_url,
        "_search_strategy": product.match_source,
    }
    order = assess_orderability(row)
    row.update(order)
    return row


def _variant_node_to_product(vnode: dict, *, match_source: str, match_term: str) -> ScannedProduct:
    prod = vnode.get("product") or {}
    merged = {
        **prod,
        "variants": {"edges": [{"node": {
            "id": vnode.get("id"),
            "title": vnode.get("title"),
            "sku": vnode.get("sku"),
            "price": vnode.get("price"),
            "availableForSale": vnode.get("availableForSale"),
            "inventoryQuantity": vnode.get("inventoryQuantity"),
            "inventoryPolicy": vnode.get("inventoryPolicy"),
        }}]},
    }
    return _node_to_product(merged, match_source=match_source, match_term=match_term)


async def _execute(client, query: str, variables: dict) -> dict:
    return await client.execute(query, variables=variables)


async def scan_products_by_query(
    query: str,
    *,
    limit: int = 25,
    match_source: str = "product_search",
    match_term: str = "",
    client=None,
) -> list[ScannedProduct]:
    from ..shopify.client import get_shopify_client
    from ..shopify.graphql_queries import CATALOG_SCAN_PRODUCTS

    client = client or get_shopify_client()
    if not client.configured:
        return []
    try:
        data = await _execute(client, CATALOG_SCAN_PRODUCTS, {"query": query, "first": limit})
        edges = (data.get("data") or {}).get("products", {}).get("edges") or []
        return [
            _node_to_product(e["node"], match_source=match_source, match_term=match_term or query)
            for e in edges
        ]
    except Exception as exc:
        logger.warning("scan_products_by_query failed query=%r: %s", query[:60], exc)
        return []


async def scan_variants_by_query(
    query: str,
    *,
    limit: int = 25,
    match_source: str = "variant_search",
    match_term: str = "",
    client=None,
) -> list[ScannedProduct]:
    from ..shopify.client import get_shopify_client
    from ..shopify.graphql_queries import CATALOG_SCAN_VARIANTS

    client = client or get_shopify_client()
    if not client.configured:
        return []
    try:
        data = await _execute(client, CATALOG_SCAN_VARIANTS, {"query": query, "first": limit})
        edges = (data.get("data") or {}).get("productVariants", {}).get("edges") or []
        return [
            _variant_node_to_product(e["node"], match_source=match_source, match_term=match_term or query)
            for e in edges
        ]
    except Exception as exc:
        logger.warning("scan_variants_by_query failed query=%r: %s", query[:60], exc)
        return []


async def list_collections(*, limit: int = 50, client=None) -> list[dict[str, str]]:
    from ..shopify.client import get_shopify_client
    from ..shopify.graphql_queries import LIST_COLLECTIONS

    client = client or get_shopify_client()
    if not client.configured:
        return []
    try:
        data = await _execute(client, LIST_COLLECTIONS, {"first": limit})
        return [
            {
                "id": str((e.get("node") or {}).get("id") or ""),
                "title": str((e.get("node") or {}).get("title") or ""),
                "handle": str((e.get("node") or {}).get("handle") or ""),
            }
            for e in (data.get("data") or {}).get("collections", {}).get("edges") or []
        ]
    except Exception as exc:
        logger.warning("list_collections failed: %s", exc)
        return []


async def scan_collection_products(
    collection_id: str,
    *,
    limit: int = 25,
    match_term: str = "",
    client=None,
) -> list[ScannedProduct]:
    from ..shopify.client import get_shopify_client
    from ..shopify.graphql_queries import COLLECTION_PRODUCTS

    client = client or get_shopify_client()
    if not client.configured:
        return []
    try:
        data = await _execute(client, COLLECTION_PRODUCTS, {"id": collection_id, "first": limit})
        coll = (data.get("data") or {}).get("collection") or {}
        edges = (coll.get("products") or {}).get("edges") or []
        return [
            _node_to_product(
                e["node"],
                match_source=f"collection:{coll.get('handle', '')}",
                match_term=match_term,
            )
            for e in edges
        ]
    except Exception as exc:
        logger.warning("scan_collection_products failed: %s", exc)
        return []


async def deep_search_term(
    term: str,
    *,
    include_all_statuses: bool = True,
    client=None,
) -> list[ScannedProduct]:
    """Search a term across statuses, variants, tags, types, handles, collections."""
    seen: set[str] = set()
    merged: list[ScannedProduct] = []

    def _add(products: list[ScannedProduct]) -> None:
        for p in products:
            key = p.product_id or p.handle or p.title
            if key and key not in seen:
                seen.add(key)
                merged.append(p)

    statuses = STATUS_QUERIES if include_all_statuses else ("status:active",)
    for status_q in statuses:
        _add(await scan_products_by_query(
            f"{status_q} title:{term}", limit=10, match_source=f"{status_q}_title", match_term=term, client=client,
        ))
        _add(await scan_products_by_query(
            f"{status_q} {term}", limit=10, match_source=f"{status_q}_broad", match_term=term, client=client,
        ))

    _add(await scan_variants_by_query(f"title:{term}", limit=10, match_term=term, client=client))
    _add(await scan_variants_by_query(f"sku:{term}", limit=5, match_term=term, client=client))

    for tag_q in (f"tag:{term}", f"product_type:{term}", f"vendor:{term}", f"handle:{term}"):
        _add(await scan_products_by_query(tag_q, limit=10, match_source=tag_q.split(":")[0], match_term=term, client=client))

    collections = await list_collections(client=client)
    term_lower = term.lower()
    for coll in collections:
        if term_lower in coll["title"].lower() or term_lower in coll["handle"].lower():
            _add(await scan_collection_products(
                coll["id"], match_term=term, client=client,
            ))

    return merged


async def count_products_by_status(*, client=None) -> dict[str, int]:
    counts: dict[str, int] = {}
    for status_q in STATUS_QUERIES:
        status = status_q.split(":")[1]
        products = await scan_products_by_query(status_q, limit=50, match_source="status_count", client=client)
        counts[status] = len(products)
    return counts


async def run_full_catalog_scan(
    search_terms: tuple[str, ...] | None = None,
    *,
    client=None,
) -> CatalogScanReport:
    from ..config import get_settings
    from ..shopify.client import get_shopify_client

    client = client or get_shopify_client()
    settings = get_settings()
    domain = getattr(settings, "SHOPIFY_SHOP_DOMAIN", "") or ""
    store_masked = domain[:4] + "***" if len(domain) > 4 else "***"
    errors: list[str] = []

    if not client.configured:
        return CatalogScanReport(
            store_masked=store_masked,
            configured=False,
            products_by_status={},
            visible_active_count=0,
            count_by_product_type={},
            count_by_vendor={},
            top_tags=[],
            collection_names=[],
            matched_products=[],
            search_term_hits={},
            errors=["Shopify client not configured"],
        )

    terms = search_terms or DEFAULT_SEARCH_TERMS
    products_by_status = await count_products_by_status(client=client)

    active_products = await scan_products_by_query("status:active", limit=50, client=client)
    visible_active_count = sum(
        1 for p in active_products if p.usability.get("voice_agent_usable")
    )

    type_counter: Counter[str] = Counter()
    vendor_counter: Counter[str] = Counter()
    tag_counter: Counter[str] = Counter()
    for p in active_products:
        type_counter[p.product_type or "(none)"] += 1
        vendor_counter[p.vendor or "(none)"] += 1
        for t in p.tags:
            tag_counter[t] += 1

    collections = await list_collections(client=client)
    collection_names = [c["title"] for c in collections]

    matched: list[ScannedProduct] = []
    seen: set[str] = set()
    term_hits: dict[str, int] = {}

    for term in terms:
        hits = await deep_search_term(term, client=client)
        term_hits[term] = len(hits)
        for p in hits:
            key = p.product_id or p.title
            if key not in seen:
                seen.add(key)
                matched.append(p)

    return CatalogScanReport(
        store_masked=store_masked,
        configured=True,
        products_by_status=products_by_status,
        visible_active_count=visible_active_count,
        count_by_product_type=dict(type_counter),
        count_by_vendor=dict(vendor_counter),
        top_tags=tag_counter.most_common(15),
        collection_names=collection_names,
        matched_products=matched,
        search_term_hits=term_hits,
        errors=errors,
    )


def format_scan_report(report: CatalogScanReport) -> str:
    lines = [
        "Shopify deep catalog scan:",
        f"  store={report.store_masked}",
        f"  configured={report.configured}",
        f"  products_by_status={report.products_by_status}",
        f"  visible_active_usable={report.visible_active_count}",
        f"  count_by_product_type={report.count_by_product_type}",
        f"  count_by_vendor={report.count_by_vendor}",
        f"  top_tags={report.top_tags[:10]}",
        f"  collections={report.collection_names[:20]}",
        f"  search_term_hits={report.search_term_hits}",
        "  matched_products:",
    ]
    for p in report.matched_products[:30]:
        best = p.best_variant()
        lines.append(
            f"    - {p.title!r} status={p.status} type={p.product_type!r} "
            f"vendor={p.vendor!r} tags={p.tags[:5]} handle={p.handle!r} "
            f"url={p.online_store_url or 'none'} variant={best.id if best else 'none'} "
            f"price={best.price if best else 'none'} inv={best.inventory_quantity if best else 'none'} "
            f"source={p.match_source} usable={p.usability.get('voice_agent_usable')} "
            f"reason={p.usability.get('summary')}"
        )
    if report.errors:
        lines.append(f"  errors={report.errors}")
    lines.append("  (API tokens not printed)")
    return "\n".join(lines)
