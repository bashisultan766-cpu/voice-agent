"""v4.16.0 — Domain boundary tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


class TestDomainBoundary:
    def test_tea_recipe_out_of_domain(self):
        from app.agent_runtime.domain_boundary import classify_domain

        d = classify_domain("How do I make tea?")
        assert d.status == "out_of_domain"
        assert "cookbook" in (d.redirect_answer or "").lower()

    def test_cricket_match_no_sports_answer(self):
        from app.agent_runtime.domain_boundary import classify_domain

        d = classify_domain("Who won the cricket match?")
        assert d.status == "out_of_domain"
        assert "cricket" in (d.redirect_answer or "").lower()
        assert "won" not in (d.redirect_answer or "").lower()

    def test_politics_news_redirect(self):
        from app.agent_runtime.domain_boundary import classify_domain

        d = classify_domain("Tell me politics news.")
        assert d.status == "out_of_domain"
        assert "commentary" in (d.redirect_answer or "").lower() or "newspaper" in (d.redirect_answer or "").lower()

    def test_cricket_books_in_domain(self):
        from app.agent_runtime.domain_boundary import classify_domain

        d = classify_domain("Do you have books about cricket?")
        assert d.catalog_search is True

    def test_cooking_magazines_in_domain(self):
        from app.agent_runtime.domain_boundary import classify_domain

        d = classify_domain("Do you have cooking magazines?")
        assert d.catalog_search is True
