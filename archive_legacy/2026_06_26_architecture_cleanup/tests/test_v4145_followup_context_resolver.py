"""v4.14.5 — Follow-up context resolver tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.commerce_session import (
    ProductCandidate,
    clear_commerce_session,
    get_commerce_session,
    update_candidates_from_facts,
)
from app.agent_runtime.followup_context_resolver import resolve_followup_context
from app.agent_runtime.tool_entity_extractor import extract_tool_entities, is_price_followup


@pytest.fixture(autouse=True)
def _clean():
    clear_commerce_session("CA4145FU")
    yield
    clear_commerce_session("CA4145FU")


def _seed_candidate():
    session = get_commerce_session("CA4145FU")
    update_candidates_from_facts(session, [
        ProductCandidate(
            candidate_id="gp1",
            product_id="p1",
            variant_id="v1",
            title="The Grandparenting Blueprint",
            author=None,
            isbn="9798893960648",
            price="$19.99",
            currency="USD",
            availability="available",
            inventory_quantity=5,
            source="isbn",
            confidence=0.99,
        )
    ])
    return session


class TestFollowupContextResolver:
    def test_price_dot_after_isbn(self):
        session = _seed_candidate()
        result = resolve_followup_context("Price.", sid="CA4145FU", commerce=session)
        assert result.resolved
        assert result.intent == "product_price_question"
        assert "$19.99" in (result.direct_answer or "")

    def test_whats_the_amount(self):
        session = _seed_candidate()
        result = resolve_followup_context("What's the amount?", sid="CA4145FU", commerce=session)
        assert result.resolved
        assert "$19.99" in (result.direct_answer or "")

    def test_price_phrase_not_product_search(self):
        entities = extract_tool_entities("I need price. What is the price?")
        assert "product_phrase" not in entities
        assert is_price_followup("I need price. What is the price?")

    def test_fuzzy_title_match(self):
        session = _seed_candidate()
        result = resolve_followup_context(
            "I need a the grand printing blueprint",
            sid="CA4145FU",
            commerce=session,
        )
        assert result.resolved
        assert "Grandparenting Blueprint" in (result.direct_answer or "")

    def test_add_it(self):
        session = _seed_candidate()
        result = resolve_followup_context("Add it.", sid="CA4145FU", commerce=session)
        assert result.resolved
        assert "added" in (result.direct_answer or "").lower()

    def test_remove_it(self):
        session = _seed_candidate()
        resolve_followup_context("Add it.", sid="CA4145FU", commerce=session)
        result = resolve_followup_context("Remove it.", sid="CA4145FU", commerce=session)
        assert result.resolved
        assert "removed" in (result.direct_answer or "").lower()
