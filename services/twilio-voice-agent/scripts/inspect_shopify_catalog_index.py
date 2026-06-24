#!/usr/bin/env python3
"""Inspect local Shopify catalog index (v4.16.1)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main() -> int:
    from app.integrations.shopify_catalog_indexer import ShopifyCatalogIndexer

    indexer = ShopifyCatalogIndexer()
    entries = indexer.load_entries()

    products = len({e.product_id for e in entries})
    variants = len(entries)
    newspapers = sum(1 for e in entries if e.product_kind == "newspaper")
    magazines = sum(1 for e in entries if e.product_kind == "magazine")
    books = sum(1 for e in entries if e.product_kind == "book")
    subscriptions = sum(1 for e in entries if e.product_kind == "subscription")
    last_synced = max((e.last_synced_at for e in entries), default=0)

    index_exists = indexer.index_path.is_file()

    print(f"CATALOG_INDEX index_exists={index_exists}")
    print(f"  products={products}")
    print(f"  variants={variants}")
    print(f"  newspapers={newspapers}")
    print(f"  magazines={magazines}")
    print(f"  books={books}")
    print(f"  subscriptions={subscriptions}")
    print(f"  last_synced_at={last_synced}")

    for entry in entries[:10]:
        print(f"  - {entry.title} ({entry.product_kind}) sku={entry.sku}")
    if len(entries) > 10:
        print(f"  ... and {len(entries) - 10} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
