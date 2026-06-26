"""v4.14.5 — Product fact normalizer tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.product_fact_normalizer import normalize_product_candidates


class TestProductFactNormalizer:
    def test_single_isbn_match(self):
        facts = {
            "product_isbn": {
                "title": "The Grandparenting Blueprint",
                "isbn": "9798893960648",
                "price": "$19.99",
                "variant_id": "v1",
                "product_id": "p1",
                "available": True,
            }
        }
        cands = normalize_product_candidates(facts, "9798893960648", "CA4145")
        assert len(cands) == 1
        assert cands[0].isbn == "9798893960648"
        assert cands[0].variant_id == "v1"

    def test_out_of_stock(self):
        facts = {
            "product_search": {
                "title": "Rare Book",
                "inventory_quantity": 0,
                "available": False,
                "variant_id": "v2",
                "product_id": "p2",
            }
        }
        cands = normalize_product_candidates(facts, "Rare Book", "CA4145")
        assert cands[0].availability == "out_of_stock"

    def test_dedupe(self):
        facts = {
            "product_isbn": {"title": "Dune", "variant_id": "v1", "product_id": "p1"},
            "product_search": {"title": "Dune", "variant_id": "v1", "product_id": "p1"},
        }
        cands = normalize_product_candidates(facts, "Dune", "CA4145")
        assert len(cands) == 1
