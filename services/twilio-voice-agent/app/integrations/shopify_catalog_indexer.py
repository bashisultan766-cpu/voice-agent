"""Shopify catalog index for fast read-only prefetch (v4.16.0)."""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_INDEX_PATH = Path("app/data/catalog_index.json")


@dataclass
class CatalogIndexEntry:
    product_id: str
    variant_id: str
    title: str
    variant_title: str = ""
    sku: str = ""
    barcode: str = ""
    price: str = ""
    available_for_sale: bool = False
    status: str = "active"
    product_type: str = ""
    tags: list[str] = field(default_factory=list)
    vendor: str = ""
    handle: str = ""
    collections: list[str] = field(default_factory=list)
    product_kind: str = ""
    normalized_terms: list[str] = field(default_factory=list)
    last_synced_at: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _normalize_terms(text: str) -> list[str]:
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    return [w for w in words if len(w) > 1]


def _entry_from_product(product: dict[str, Any], synced_at: int) -> list[CatalogIndexEntry]:
    entries: list[CatalogIndexEntry] = []
    title = str(product.get("title") or "")
    product_type = str(product.get("product_type") or "")
    tags = list(product.get("tags") or [])
    vendor = str(product.get("vendor") or "")
    handle = str(product.get("handle") or "")
    status = str(product.get("status") or "active")
    collections = list(product.get("collections") or [])
    kind = _infer_kind(title, product_type, tags)
    base_terms = _normalize_terms(" ".join([title, product_type, vendor, " ".join(tags)]))

    for variant in product.get("variants") or [{}]:
        variant_title = str(variant.get("title") or "")
        sku = str(variant.get("sku") or "")
        barcode = str(variant.get("barcode") or "")
        terms = list(dict.fromkeys(base_terms + _normalize_terms(f"{variant_title} {sku} {barcode}")))
        entries.append(
            CatalogIndexEntry(
                product_id=str(product.get("product_id") or product.get("id") or ""),
                variant_id=str(variant.get("variant_id") or variant.get("id") or ""),
                title=title,
                variant_title=variant_title,
                sku=sku,
                barcode=barcode,
                price=str(variant.get("price") or ""),
                available_for_sale=bool(variant.get("available_for_sale", False)),
                status=status,
                product_type=product_type,
                tags=tags,
                vendor=vendor,
                handle=handle,
                collections=collections,
                product_kind=kind,
                normalized_terms=terms,
                last_synced_at=synced_at,
            )
        )
    return entries


def _infer_kind(title: str, product_type: str, tags: list[str]) -> str:
    blob = " ".join([title, product_type, " ".join(tags)]).lower()
    if "newspaper" in blob or "usa today" in blob:
        return "newspaper"
    if "magazine" in blob:
        return "magazine"
    if "subscription" in blob:
        return "subscription"
    return "book"


class ShopifyCatalogIndexer:
    def __init__(self, index_path: Path | None = None) -> None:
        self.index_path = index_path or DEFAULT_INDEX_PATH

    def load_entries(self) -> list[CatalogIndexEntry]:
        path = self.index_path
        if not path.is_file():
            return []
        raw = json.loads(path.read_text(encoding="utf-8"))
        items = raw if isinstance(raw, list) else raw.get("entries", [])
        return [CatalogIndexEntry(**item) for item in items]

    def save_entries(self, entries: list[CatalogIndexEntry]) -> None:
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"entries": [e.to_dict() for e in entries], "saved_at": int(time.time())}
        self.index_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def build_from_scan(self, products: list[dict[str, Any]]) -> list[CatalogIndexEntry]:
        synced = int(time.time())
        entries: list[CatalogIndexEntry] = []
        for product in products:
            entries.extend(_entry_from_product(product, synced))
        return entries

    def search(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        terms = _normalize_terms(query)
        if not terms:
            return []
        scored: list[tuple[float, CatalogIndexEntry]] = []
        for entry in self.load_entries():
            score = sum(1 for t in terms if t in entry.normalized_terms or t in entry.title.lower())
            if score > 0:
                scored.append((score, entry))
        scored.sort(key=lambda x: (-x[0], x[1].title))
        results = []
        for score, entry in scored[:limit]:
            results.append({**entry.to_dict(), "match_score": score})
        return results


def search_catalog_index(query: str, limit: int = 10, settings=None) -> list[dict[str, Any]]:
    indexer = ShopifyCatalogIndexer()
    return indexer.search(query, limit=limit)


def sync_index_from_shopify(*, dry_run: bool = False, settings=None) -> dict[str, Any]:
    import asyncio

    if settings is None:
        from ..config import get_settings
        settings = get_settings()
    indexer = ShopifyCatalogIndexer()
    products: list[dict] = []
    if dry_run:
        # Dry-run: report what would happen without touching the API or disk
        existing = indexer.load_entries()
        return {"entries": len(existing), "dry_run": True, "products_scanned": 0}
    if getattr(settings, "shopify_configured", False):
        try:
            from .shopify_catalog_scanner import run_full_catalog_scan

            report = asyncio.run(run_full_catalog_scan())
            for item in report.matched_products:
                best = item.best_variant()
                products.append({
                    "product_id": item.product_id,
                    "title": item.title,
                    "handle": item.handle,
                    "status": item.status,
                    "product_type": item.product_type,
                    "vendor": item.vendor,
                    "tags": item.tags,
                    "collections": [],
                    "variants": [{
                        "variant_id": best.id if best else "",
                        "title": best.title if best else "",
                        "sku": best.sku if best else "",
                        "barcode": "",
                        "price": best.price if best else "",
                        "available_for_sale": best.available_for_sale if best else False,
                    }],
                })
        except Exception as exc:
            logger.warning("catalog_index_sync_scan_failed err=%s", str(exc)[:60])
    entries = indexer.build_from_scan(products) if products else indexer.load_entries()
    if not dry_run and products:
        indexer.save_entries(entries)
    return {"entries": len(entries), "dry_run": dry_run, "products_scanned": len(products)}
