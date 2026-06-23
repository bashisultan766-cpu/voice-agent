"""v4.14.4 — Tool entity extractor tests."""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


class TestToolEntityExtractor:
    def test_plain_isbn(self):
        from app.agent_runtime.tool_entity_extractor import extract_tool_entities

        entities = extract_tool_entities("ISBN is 9798993861807")
        assert entities["isbn"] == "9798993861807"

    def test_spaced_isbn(self):
        from app.agent_runtime.tool_entity_extractor import extract_tool_entities

        text = "The ISBN number is 9 7 9 8 9 9 3 8 6 1 8 0 7."
        entities = extract_tool_entities(text)
        assert entities["isbn"] == "9798993861807"

    def test_hyphen_isbn(self):
        from app.agent_runtime.tool_entity_extractor import extract_tool_entities

        entities = extract_tool_entities("ISBN is 978-0-441-17271-9")
        assert entities["isbn"] == "9780441172719"

    def test_title_extraction(self):
        from app.agent_runtime.tool_entity_extractor import extract_tool_entities

        entities = extract_tool_entities("The title is Game of Thrones")
        assert entities.get("title") == "Game of Thrones"
        assert entities.get("product_phrase") == "Game of Thrones"

    def test_author_extraction(self):
        from app.agent_runtime.tool_entity_extractor import extract_tool_entities

        entities = extract_tool_entities("books by Stephen King")
        assert "Stephen King" in entities.get("author", "")

    def test_subject_extraction(self):
        from app.agent_runtime.tool_entity_extractor import extract_tool_entities

        entities = extract_tool_entities("Do you have books about cricket?")
        assert "cricket" in entities.get("product_phrase", "").lower()

    def test_order_number(self):
        from app.agent_runtime.tool_entity_extractor import extract_tool_entities

        entities = extract_tool_entities("Order number is 1234")
        assert entities.get("order_number") == "1234"

    def test_cart_add(self):
        from app.agent_runtime.tool_entity_extractor import extract_tool_entities

        entities = extract_tool_entities("add it")
        assert entities.get("cart_action") == "add"

    def test_merges_decision_fields(self):
        from app.agent_runtime.tool_entity_extractor import extract_tool_entities

        decision = {
            "search_query": "Dune",
            "tool_entities": {"isbn": "9780441172719"},
        }
        entities = extract_tool_entities("look it up", decision=decision)
        assert entities["isbn"] == "9780441172719"
        assert entities["product_phrase"] == "Dune"
