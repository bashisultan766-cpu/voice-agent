"""v4.14.7 — Universal catalog entity extractor tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.tool_entity_extractor import extract_tool_entities


class TestUniversalCatalogEntityExtractor:
    def test_usa_today_entities(self):
        phrase = "I need a newspaper, like USA Today 5 day delivery for 3 months."
        entities = extract_tool_entities(phrase)
        assert entities.get("product_kind") == "newspaper"
        assert entities.get("publication_title") == "USA Today"
        assert "5 day" in entities.get("delivery_frequency", "")
        assert entities.get("subscription_term") == "3 months"
        assert entities.get("subscription_duration_months") == "3"
        assert "a newspaper like" not in entities.get("product_phrase", "").lower()

    def test_availability_phrase_entities(self):
        phrase = "USA Today 5 day delivery for 3 months paper available."
        entities = extract_tool_entities(phrase)
        assert entities.get("publication_title") == "USA Today"
        assert "available" not in entities.get("product_phrase", "").lower()

    def test_people_magazine_entities(self):
        entities = extract_tool_entities("People magazine 6 months")
        assert entities.get("product_kind") == "magazine"
        assert entities.get("publication_title") == "People"
        assert entities.get("subscription_term") == "6 months"
