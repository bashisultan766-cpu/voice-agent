#!/usr/bin/env python3
"""Verify catalog index readiness before deploy (v4.16.1).

Outputs:
  CATALOG_INDEX_READY=PASS  — index exists and has products
  CATALOG_INDEX_READY=WARN  — index empty but Shopify fallback is enabled (safe to deploy)
  CATALOG_INDEX_READY=FAIL  — index empty and fallback disabled (block deploy)
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main() -> int:
    from app.integrations.shopify_catalog_indexer import ShopifyCatalogIndexer, search_catalog_index
    from app.config import get_settings

    settings = get_settings()
    indexer = ShopifyCatalogIndexer()
    entries = indexer.load_entries()

    index_exists = indexer.index_path.is_file()
    product_count = len({e.product_id for e in entries if e.product_id})
    variant_count = len(entries)
    shopify_configured = settings.shopify_configured

    print(f"CATALOG_INDEX_CHECK index_exists={index_exists} products={product_count} variants={variant_count}")

    if product_count > 0:
        # Run search probes
        usa_hits = search_catalog_index("USA Today 5 day delivery 3 months", limit=3)
        people_hits = search_catalog_index("People magazine 6 months", limit=3)
        print(f"  probe 'USA Today': hits={len(usa_hits)}")
        print(f"  probe 'People magazine': hits={len(people_hits)}")
        if not usa_hits:
            print("  WARN: 'USA Today' not in index — may need re-sync after publishing products")
        if not people_hits:
            print("  WARN: 'People magazine' not in index — may need re-sync after publishing products")
        print("CATALOG_INDEX_READY=PASS")
        return 0

    # Index is empty
    if shopify_configured:
        print("  INFO: Index empty — live Shopify fallback is active (catalog_scout falls back to live API)")
        print("  ACTION: Run 'python scripts/sync_shopify_catalog_index.py' after first deploy to populate")
        print("CATALOG_INDEX_READY=WARN")
        return 0

    print("  ERROR: Index empty and Shopify not configured — catalog search will return no results")
    print("CATALOG_INDEX_READY=FAIL")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
