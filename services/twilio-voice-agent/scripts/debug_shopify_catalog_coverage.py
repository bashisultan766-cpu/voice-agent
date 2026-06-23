#!/usr/bin/env python3
"""Deep Shopify catalog coverage scanner (v4.14.8). Masks secrets."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main() -> int:
    from app.integrations.shopify_catalog_scanner import format_scan_report, run_full_catalog_scan

    report = asyncio.run(run_full_catalog_scan())
    print(format_scan_report(report))
    if not report.configured:
        return 1
    usa_hits = report.search_term_hits.get("USA Today", 0)
    orderable = [p for p in report.matched_products if p.usability.get("can_add_to_cart")]
    if usa_hits == 0:
        print(
            "  API coverage mismatch: USA Today not found — product may be unpublished, "
            "draft, archived, missing product_type/tags, or not in Admin API scope."
        )
    elif not any("USA Today" in p.title for p in orderable):
        print(
            "  USA Today found in API but not orderable — check status, publish channel, variant/price."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
