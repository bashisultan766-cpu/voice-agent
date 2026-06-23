"""v4.14.7 — Publication product fact normalizer tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.product_fact_normalizer import normalize_product_candidates


class TestPublicationNormalizer:
    def test_newspaper_without_isbn(self):
        facts = {
            "universal_catalog_search": {
                "title": "USA Today 5 Day Delivery - 3 Months",
                "price": "$149.99",
                "available": True,
                "variant_id": "v-newspaper-1",
                "product_id": "p-newspaper-1",
                "product_kind": "newspaper",
                "product_type": "newspaper",
            }
        }
        cands = normalize_product_candidates(
            facts,
            "USA Today 5 day delivery for 3 months",
            "CAnorm1",
            query_entities={
                "product_kind": "newspaper",
                "publication_title": "USA Today",
                "delivery_frequency": "5 day",
                "subscription_term": "3 months",
            },
        )
        assert len(cands) == 1
        c = cands[0]
        assert c.title
        assert c.variant_id == "v-newspaper-1"
        assert c.isbn is None
        assert c.product_kind == "newspaper"

    def test_magazine_without_isbn(self):
        facts = {
            "universal_catalog_search": {
                "title": "People Magazine 6 Month Subscription",
                "price": "$89.99",
                "variant_id": "v-mag-1",
                "product_id": "p-mag-1",
                "product_type": "magazine",
            }
        }
        cands = normalize_product_candidates(
            facts,
            "People magazine 6 months",
            "CAnorm2",
            query_entities={"product_kind": "magazine", "publication_title": "People"},
        )
        assert cands[0].variant_id == "v-mag-1"
