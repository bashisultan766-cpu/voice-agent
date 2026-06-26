"""v4.14.4 — Tool category mapper tests."""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


class TestToolCategoryMapper:
    def test_isbn_lookup_maps_to_isbn_search(self):
        from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents
        from app.workers.orchestrator import _INTENT_WORKERS

        decision = {"tool_categories": ["isbn_lookup"], "intent": "isbn_lookup"}
        entities = {"isbn": "9780441172719"}
        plans = map_tool_categories_to_worker_intents(decision, entities)
        assert plans[0].worker_intent == "isbn_search"
        assert plans[0].worker_names == _INTENT_WORKERS["isbn_search"]

    def test_catalog_title_maps_book_title_search(self):
        from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents

        decision = {"tool_categories": ["catalog_search"], "intent": "book_title_search"}
        entities = {"title": "Game of Thrones", "product_phrase": "Game of Thrones"}
        plans = map_tool_categories_to_worker_intents(decision, entities)
        assert plans[0].worker_intent == "book_title_search"

    def test_order_lookup(self):
        from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents

        decision = {"tool_categories": ["order_lookup"], "intent": "order_lookup"}
        plans = map_tool_categories_to_worker_intents(decision, {"order_number": "1234"})
        assert plans[0].worker_intent == "order_lookup"

    def test_refund_lookup(self):
        from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents

        decision = {"tool_categories": ["refund_lookup"], "intent": "refund_lookup"}
        plans = map_tool_categories_to_worker_intents(decision, {"order_number": "1234"})
        assert plans[0].worker_intent == "refund_detail"

    def test_facility_approval(self):
        from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents

        decision = {"tool_categories": ["facility_approval"], "intent": "facility"}
        plans = map_tool_categories_to_worker_intents(
            decision, {"facility_name": "Red Rock"},
        )
        assert plans[0].worker_intent == "facility_approval"

    def test_cart_mutation_add(self):
        from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents

        decision = {"tool_categories": ["cart_mutation"], "intent": "add_to_cart"}
        plans = map_tool_categories_to_worker_intents(decision, {"cart_action": "add"})
        assert plans[0].worker_intent == "add_to_cart"
        assert plans[0].mutating is True

    def test_assert_all_mapped_worker_intents_exist(self):
        from app.agent_runtime.tool_category_mapper import assert_all_mapped_worker_intents_exist

        assert_all_mapped_worker_intents_exist()
