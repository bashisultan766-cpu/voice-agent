#!/usr/bin/env python3
"""Sync Shopify catalog into local index (v4.16.0)."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync Shopify catalog index")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    from app.integrations.shopify_catalog_indexer import sync_index_from_shopify

    result = sync_index_from_shopify(dry_run=args.dry_run)
    print(f"CATALOG_INDEX_SYNC entries={result['entries']} dry_run={result['dry_run']} products={result['products_scanned']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
