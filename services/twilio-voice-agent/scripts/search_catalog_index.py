#!/usr/bin/env python3
"""Search local Shopify catalog index (v4.16.1)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Search catalog index")
    parser.add_argument("--query", required=True)
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--allow-empty", action="store_true",
                        help="Exit 0 even when index has zero hits (expected before first sync)")
    parser.add_argument("--json", dest="json_out", action="store_true",
                        help="Output results as JSON")
    args = parser.parse_args(argv)

    from app.integrations.shopify_catalog_indexer import search_catalog_index

    hits = search_catalog_index(args.query, limit=args.limit)

    if args.json_out:
        print(json.dumps({"query": args.query, "hits": len(hits), "results": hits}))
        return 0

    print(f"CATALOG_INDEX_SEARCH query={args.query!r} hits={len(hits)}")
    for hit in hits:
        print(f"  - {hit.get('title')} score={hit.get('match_score')} kind={hit.get('product_kind')}")

    if not hits and not args.allow_empty:
        print("WARN: no hits — run sync_shopify_catalog_index.py to populate index")
        return 0

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
