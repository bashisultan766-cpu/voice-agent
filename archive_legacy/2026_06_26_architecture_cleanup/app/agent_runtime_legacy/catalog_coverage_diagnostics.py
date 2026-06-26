"""Catalog visibility diagnostics — why API may miss website products (v4.14.8)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..integrations.shopify_catalog_scanner import (
    ScannedProduct,
    deep_search_term,
    scan_products_by_query,
    scan_variants_by_query,
)


@dataclass
class CatalogCoverageReport:
    search_term: str
    exact_active: list[ScannedProduct] = field(default_factory=list)
    draft_archived: list[ScannedProduct] = field(default_factory=list)
    variant_matches: list[ScannedProduct] = field(default_factory=list)
    collection_matches: list[ScannedProduct] = field(default_factory=list)
    broad_matches: list[ScannedProduct] = field(default_factory=list)
    likely_issue: str = ""
    recommended_shopify_fix: str = ""
    orderable_via_api: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "search_term": self.search_term,
            "exact_active_count": len(self.exact_active),
            "draft_archived_count": len(self.draft_archived),
            "variant_match_count": len(self.variant_matches),
            "collection_match_count": len(self.collection_matches),
            "broad_match_count": len(self.broad_matches),
            "likely_issue": self.likely_issue,
            "recommended_shopify_fix": self.recommended_shopify_fix,
            "orderable_via_api": self.orderable_via_api,
        }


def _split_by_status(products: list[ScannedProduct]) -> tuple[list[ScannedProduct], list[ScannedProduct]]:
    active: list[ScannedProduct] = []
    other: list[ScannedProduct] = []
    for p in products:
        if p.status == "ACTIVE" and p.usability.get("can_add_to_cart"):
            active.append(p)
        elif p.status == "ACTIVE":
            active.append(p)
        else:
            other.append(p)
    return active, other


def _recommend_fix(report: CatalogCoverageReport) -> str:
    if report.orderable_via_api:
        return "No fix required — product is active and checkout-ready via Admin API."
    if report.draft_archived:
        return (
            "Set product status to ACTIVE, publish to Online Store, add product_type "
            "(Newspaper/Magazine/Subscription), tags (newspaper, subscription, publication title), "
            "and ensure at least one variant has price + availableForSale."
        )
    if report.variant_matches or report.broad_matches:
        return (
            "Product may exist under variant/collection/tag but lacks active published parent. "
            "Activate product, add product_type/tags, publish to Online Store sales channel."
        )
    return (
        "Product not found in Admin API at all. Verify it exists in Shopify admin, is not "
        "a third-party embed only, and is assigned to this store catalog. Add to Newspapers/Magazines collection."
    )


async def diagnose_catalog_visibility(
    search_term: str,
    *,
    client=None,
) -> CatalogCoverageReport:
    term = (search_term or "").strip()
    report = CatalogCoverageReport(search_term=term)

    exact_active = await scan_products_by_query(
        f"status:active title:{term}", limit=10, match_source="exact_active_title", match_term=term, client=client,
    )
    report.exact_active = [p for p in exact_active if p.status == "ACTIVE"]

    all_hits = await deep_search_term(term, include_all_statuses=True, client=client)
    active_hits, draft_archived = _split_by_status(all_hits)
    report.draft_archived = [p for p in all_hits if p.status in ("DRAFT", "ARCHIVED")]
    report.broad_matches = all_hits

    variant_hits = await scan_variants_by_query(f"title:{term}", limit=10, match_term=term, client=client)
    report.variant_matches = variant_hits

    report.collection_matches = [
        p for p in all_hits if p.match_source.startswith("collection:")
    ]

    orderable = [p for p in all_hits if p.usability.get("can_add_to_cart")]
    report.orderable_via_api = bool(orderable)

    if report.exact_active and any(p.usability.get("can_add_to_cart") for p in report.exact_active):
        report.likely_issue = "Active exact title match found and checkout-ready."
    elif report.exact_active:
        report.likely_issue = "Active title match found but not checkout-ready (missing variant/price/publish)."
    elif report.draft_archived:
        report.likely_issue = "Product exists but status is draft or archived."
    elif report.variant_matches:
        report.likely_issue = "Match found only at variant level — parent product may be unpublished."
    elif report.collection_matches:
        report.likely_issue = "Match found in collection but not as active searchable product."
    elif report.broad_matches:
        report.likely_issue = "Broad/tag/type match only — product_type/tags may be missing or mislabeled."
    else:
        report.likely_issue = "No match in Shopify Admin API for this term."

    report.recommended_shopify_fix = _recommend_fix(report)
    return report


def format_diagnosis(report: CatalogCoverageReport) -> str:
    lines = [
        f'Catalog visibility diagnosis for "{report.search_term}":',
        f"- exact active product: {len(report.exact_active)} "
        + (f"({report.exact_active[0].title})" if report.exact_active else "none"),
        f"- draft/archived: {len(report.draft_archived)}"
        + (f" ({', '.join(p.title for p in report.draft_archived[:3])})" if report.draft_archived else ""),
        f"- variant match: {len(report.variant_matches)}"
        + (f" ({report.variant_matches[0].title})" if report.variant_matches else "none"),
        f"- collection match: {len(report.collection_matches)}",
        f"- broad/tag/type match: {len(report.broad_matches)}",
        f"- orderable via API: {'yes' if report.orderable_via_api else 'no'}",
        f"- likely issue: {report.likely_issue}",
        f"- recommended Shopify fix: {report.recommended_shopify_fix}",
    ]
    return "\n".join(lines)
