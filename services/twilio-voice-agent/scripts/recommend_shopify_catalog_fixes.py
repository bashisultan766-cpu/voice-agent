#!/usr/bin/env python3
"""Recommend Shopify catalog data quality fixes (dry-run only, v4.14.8)."""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main() -> int:
    dry_run = os.environ.get("SHOPIFY_CATALOG_FIX_DRY_RUN", "true").lower() != "false"
    from app.agent_runtime.shopify_catalog_recommendations import generate_recommendations

    result = asyncio.run(generate_recommendations())
    print("Shopify catalog fix recommendations (dry-run):")
    print(f"  dry_run={dry_run}")
    print(f"  store={result['report'].get('store_masked', '***')}")
    for i, rec in enumerate(result["recommendations"], 1):
        print(f"  {i}. {rec}")
    if dry_run:
        print("  No API mutations performed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
