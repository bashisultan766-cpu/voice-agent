"""Generate Shopify catalog data quality recommendations (v4.14.8 dry-run only)."""
from __future__ import annotations

from typing import Any

from app.integrations.shopify_catalog_scanner import CatalogScanReport, run_full_catalog_scan


def recommend_fixes_from_report(report: CatalogScanReport) -> list[str]:
    recs: list[str] = []
    if report.products_by_status.get("draft", 0) > 0:
        recs.append(f"Set {report.products_by_status['draft']} draft product(s) to ACTIVE.")
    if report.products_by_status.get("archived", 0) > 0:
        recs.append(f"Review {report.products_by_status['archived']} archived product(s); unarchive if they should be sold.")

    newspaper_hits = report.search_term_hits.get("newspaper", 0)
    usa_hits = report.search_term_hits.get("USA Today", 0)
    if newspaper_hits == 0:
        recs.append("Add product_type: Newspaper for newspaper products.")
        recs.append("Add tags: newspaper, subscription, publication title (e.g. USA Today, 5-day, 3-month).")
        recs.append("Create collection: Newspapers and assign newspaper products.")
    if usa_hits == 0:
        recs.append("Ensure USA Today product title includes searchable phrase 'USA Today'.")
        recs.append("Publish USA Today product to Online Store sales channel.")

    magazine_hits = report.search_term_hits.get("magazine", 0)
    if magazine_hits == 0:
        recs.append("Add product_type: Magazine for magazine products.")
        recs.append("Create collection: Magazines.")

    for p in report.matched_products:
        if not p.usability.get("can_add_to_cart"):
            recs.append(
                f"Fix '{p.title}': {p.usability.get('summary', 'not checkout-ready')} — "
                "ensure active variant with price and availableForSale."
            )
        if not p.product_type:
            recs.append(f"Add product_type to '{p.title}' (Newspaper / Magazine / Book / Subscription).")
        if not p.tags:
            recs.append(f"Add tags to '{p.title}' (newspaper/magazine/subscription + title tokens).")

    if not recs:
        recs.append("Catalog scan shows no critical data quality issues for configured search terms.")

    seen: set[str] = set()
    unique: list[str] = []
    for r in recs:
        if r not in seen:
            seen.add(r)
            unique.append(r)
    return unique


async def generate_recommendations() -> dict[str, Any]:
    report = await run_full_catalog_scan()
    return {
        "report": report.to_dict(),
        "recommendations": recommend_fixes_from_report(report),
        "dry_run": True,
    }
