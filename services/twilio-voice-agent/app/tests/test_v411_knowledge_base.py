"""v4.11 — Knowledge base tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.knowledge_base import (
    is_knowledge_base_loaded,
    retrieve_knowledge_snippets,
)


class TestKnowledgeBase:
    def test_knowledge_base_loaded(self):
        assert is_knowledge_base_loaded()

    def test_shipping_question_retrieves_shipping(self):
        snippets = retrieve_knowledge_snippets("", intent="shipping_question")
        text = " ".join(snippets).lower()
        assert "shipping" in text or "subtotal" in text

    def test_facility_question_retrieves_facility(self):
        snippets = retrieve_knowledge_snippets("facility approval", intent="facility_approval")
        text = " ".join(snippets).lower()
        assert "facility" in text

    def test_red_river_retrieves_override(self):
        snippets = retrieve_knowledge_snippets("Red River Vengeance")
        text = " ".join(snippets).lower()
        assert "red river" in text or "out of stock" in text

    def test_off_domain_retrieves_boundary(self):
        snippets = retrieve_knowledge_snippets("Who is the president?", intent="out_of_domain")
        text = " ".join(snippets).lower()
        assert "domain" in text or "catalog" in text

    def test_prompt_size_controlled(self):
        snippets = retrieve_knowledge_snippets(
            "shipping facility payment cancel backorder",
            intent="shipping_question",
            max_snippets=2,
            max_chars=600,
        )
        total = sum(len(s) for s in snippets)
        assert total <= 700
