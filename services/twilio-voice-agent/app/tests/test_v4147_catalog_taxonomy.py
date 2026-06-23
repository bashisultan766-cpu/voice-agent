"""v4.14.7 — Catalog taxonomy tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.catalog_taxonomy import (
    ProductKind,
    build_product_phrase,
    detect_product_kind,
    detect_publication_terms,
    is_catalog_request,
    is_generic_availability_only,
    is_magazine_request,
    is_newspaper_request,
    is_vague_newspaper_request,
)


class TestCatalogTaxonomy:
    def test_detect_newspaper_kind(self):
        assert detect_product_kind("I need a newspaper") == ProductKind.NEWSPAPER

    def test_detect_magazine_kind(self):
        assert detect_product_kind("People magazine 6 months") == ProductKind.MAGAZINE

    def test_usa_today_terms(self):
        terms = detect_publication_terms(
            "I need a newspaper, like USA Today 5 day delivery for 3 months."
        )
        assert terms["title"] == "USA Today"
        assert terms["product_kind"] == "newspaper"
        assert "5 day" in terms.get("frequency", "")
        assert terms.get("duration") == "3 months"
        assert terms.get("subscription_duration_months") == 3

    def test_build_product_phrase_clean(self):
        phrase = build_product_phrase(
            "USA Today 5 day delivery for 3 months paper available."
        )
        assert "USA Today" in phrase
        assert "available" not in phrase.lower()
        assert "paper available" not in phrase.lower()

    def test_is_catalog_request_newspaper(self):
        assert is_catalog_request("Can you give me newspaper?")

    def test_generic_availability_only(self):
        assert is_generic_availability_only("available?")
        assert not is_generic_availability_only(
            "USA Today 5 day delivery for 3 months paper available."
        )

    def test_vague_newspaper(self):
        assert is_vague_newspaper_request("Can you give me newspaper?")

    def test_news_paper_spacing(self):
        assert is_newspaper_request("I need a news paper")

    def test_magazine_request(self):
        assert is_magazine_request("Do you have magazines?")
