"""v4.16.0 — Shopify catalog indexer tests."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


class TestShopifyCatalogIndexer:
    def test_index_search_normalized_candidates(self, tmp_path: Path):
        from app.integrations.shopify_catalog_indexer import CatalogIndexEntry, ShopifyCatalogIndexer

        indexer = ShopifyCatalogIndexer(index_path=tmp_path / "index.json")
        entries = [
            CatalogIndexEntry(
                product_id="p1",
                variant_id="v1",
                title="USA Today 5 Day Delivery 3 Months",
                sku="USAT-5D-3M",
                product_kind="newspaper",
                normalized_terms=["usa", "today", "delivery", "months", "newspaper"],
                available_for_sale=True,
            ),
            CatalogIndexEntry(
                product_id="p2",
                variant_id="v2",
                title="People Magazine",
                product_kind="magazine",
                normalized_terms=["people", "magazine"],
                available_for_sale=True,
            ),
        ]
        indexer.save_entries(entries)
        hits = indexer.search("USA Today 5 day delivery 3 months")
        assert hits
        assert hits[0]["product_kind"] == "newspaper"

    def test_live_verification_flag_on_index_hits(self):
        from app.integrations.shopify_catalog_indexer import CatalogIndexEntry, ShopifyCatalogIndexer

        indexer = ShopifyCatalogIndexer()
        entries = indexer.build_from_scan([{
            "product_id": "p1",
            "title": "Test Book",
            "status": "active",
            "variants": [{"variant_id": "v1", "available_for_sale": True, "price": "9.99"}],
        }])
        assert entries
        assert entries[0].available_for_sale is True

    def test_sync_dry_run_no_write(self, tmp_path: Path, monkeypatch):
        from app.integrations import shopify_catalog_indexer as mod
        from app.config import Settings

        monkeypatch.setattr(mod, "DEFAULT_INDEX_PATH", tmp_path / "index.json")
        # Use isolated settings with no Shopify credentials to prevent real API calls.
        test_settings = Settings(
            SHOPIFY_SHOP_DOMAIN="",
            SHOPIFY_ADMIN_ACCESS_TOKEN="",
            OPENAI_API_KEY="test-key",
        )
        result = mod.sync_index_from_shopify(dry_run=True, settings=test_settings)
        assert result["dry_run"] is True
        assert not (tmp_path / "index.json").exists()
