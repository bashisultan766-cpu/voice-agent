"""v4.14.8 — Shopify data quality recommendation tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.shopify_catalog_recommendations import recommend_fixes_from_report
from app.integrations.shopify_catalog_scanner import CatalogScanReport


class TestShopifyDataQualityRecommendations:
    def test_recommends_product_type_and_tags(self):
        report = CatalogScanReport(
            store_masked="test***",
            configured=True,
            products_by_status={"active": 5, "draft": 2, "archived": 0},
            visible_active_count=3,
            count_by_product_type={},
            count_by_vendor={},
            top_tags=[],
            collection_names=[],
            matched_products=[],
            search_term_hits={"newspaper": 0, "USA Today": 0, "magazine": 0},
        )
        recs = recommend_fixes_from_report(report)
        joined = " ".join(recs).lower()
        assert "product_type" in joined or "newspaper" in joined
        assert "collection" in joined or "tags" in joined
        assert "active" in joined or "draft" in joined
