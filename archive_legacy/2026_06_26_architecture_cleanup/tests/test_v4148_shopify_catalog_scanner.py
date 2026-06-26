"""v4.14.8 — Shopify catalog scanner tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.integrations.shopify_catalog_scanner import (
    ScannedProduct,
    ScannedVariant,
    assess_voice_agent_usability,
    mask_secrets,
    scanned_product_to_search_row,
)


def _draft_product(title: str = "USA Today 5 Day") -> ScannedProduct:
    p = ScannedProduct(
        product_id="gid://shopify/Product/1",
        title=title,
        handle="usa-today",
        status="DRAFT",
        product_type="",
        vendor="SureShot",
        tags=[],
        online_store_url="",
        published_at=None,
        published_online=False,
        publications=[],
        variants=[ScannedVariant("v1", "Default", "SKU1", "149.99", False, 0)],
    )
    p.usability = assess_voice_agent_usability(p)
    return p


def _active_product(title: str = "USA Today 5 Day Delivery") -> ScannedProduct:
    p = ScannedProduct(
        product_id="gid://shopify/Product/2",
        title=title,
        handle="usa-today-active",
        status="ACTIVE",
        product_type="Newspaper",
        vendor="SureShot",
        tags=["newspaper", "USA Today"],
        online_store_url="https://store.example/products/usa-today",
        published_at="2024-01-01",
        published_online=True,
        publications=["Online Store"],
        variants=[ScannedVariant("v2", "3 Month", "SKU2", "149.99", True, 10)],
    )
    p.usability = assess_voice_agent_usability(p)
    return p


class TestShopifyCatalogScanner:
    def test_masks_tokens(self):
        masked = mask_secrets("Authorization: shpat_abc123secret token")
        assert "shpat_" not in masked
        assert "***" in masked

    def test_draft_not_voice_usable(self):
        p = _draft_product()
        assert p.usability["voice_agent_usable"] is False
        assert "DRAFT" in p.usability["summary"]

    def test_active_newspaper_usable(self):
        p = _active_product()
        assert p.usability["can_add_to_cart"] is True

    def test_scanned_product_to_row_orderability(self):
        row = scanned_product_to_search_row(_draft_product())
        assert row["can_add_to_cart"] is False
        assert row["status"] == "DRAFT"

    def test_variant_title_preserved(self):
        p = _active_product()
        assert p.variants[0].title == "3 Month"
