"""v4.12 — Out-of-domain and router hint override tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


def _session():
    from app.state.models import SessionState
    return SessionState(
        session_id="s412o",
        call_sid="CA00000412O",
        from_number="+15550004128",
        to_number="+15559998888",
    )


def _memory():
    from app.agent_runtime.memory_packet import MemoryPacket
    return MemoryPacket()


def _state():
    from app.agent_runtime.types import StatePacket
    return StatePacket()


@pytest.mark.asyncio
class TestV412OutOfDomain:
    async def test_black_coffee_not_book_title_search(self):
        from app.agent_runtime.llm_supervisor import get_supervisor

        d = await get_supervisor().decide(
            _session(),
            "How can I make black coffee?",
            _memory(),
            _state(),
            router_intent="book_title_search",
            router_entities={"product_phrase": "black coffee"},
        )
        assert d.user_intent == "out_of_domain"
        assert d.source in ("fast_path", "router_override")

    async def test_black_office_not_product_search(self):
        from app.agent_runtime.llm_supervisor import get_supervisor

        d = await get_supervisor().decide(
            _session(),
            "black office",
            _memory(),
            _state(),
            router_intent="book_title_search",
            router_entities={"product_phrase": "black office"},
        )
        assert d.user_intent == "out_of_domain"
        assert d.source in ("fast_path", "router_override")

    async def test_books_about_coffee_allowed(self):
        from app.agent_runtime.llm_supervisor import get_supervisor

        d = await get_supervisor().decide(
            _session(),
            "Do you have books about coffee?",
            _memory(),
            _state(),
        )
        assert d.user_intent == "book_topic_allowed"
        assert any(w.worker == "catalog_search" for w in d.worker_requests)

    async def test_book_called_black_coffee_title_search_allowed(self):
        from app.catalog.query_specificity import (
            has_explicit_book_search_context,
            score_product_query_specificity,
        )

        q = "Do you have a book called Black Coffee"
        assert has_explicit_book_search_context(q)
        spec = score_product_query_specificity(q)
        assert spec.is_searchable

    async def test_donald_trump_out_of_domain(self):
        from app.agent_runtime.llm_supervisor import get_supervisor

        d = await get_supervisor().decide(
            _session(), "Who is Donald Trump?", _memory(), _state(),
        )
        assert d.user_intent == "out_of_domain"

    async def test_intent_contract_blocks_how_to_search(self):
        from app.pipeline.intent_contract import validate_intent_contract

        decision = validate_intent_contract(
            "book_title_search",
            {"product_phrase": "how can I make black coffee", "query": "how can I make black coffee"},
        )
        assert decision.allowed is False
        assert decision.resolved_intent == "out_of_domain_question"

    async def test_query_specificity_blocks_coffee_how_to(self):
        from app.catalog.query_specificity import (
            is_off_domain_non_book_query,
            may_search_catalog,
        )

        assert is_off_domain_non_book_query("how can I make black coffee")
        assert not may_search_catalog("how can I make black coffee")

    async def test_router_hint_cannot_force_bad_search(self):
        from app.catalog.query_specificity import should_block_router_product_search

        assert should_block_router_product_search(
            "who is Donald Trump", "book_title_search",
        )
        assert should_block_router_product_search(
            "how to make coffee", "product_search",
        )
