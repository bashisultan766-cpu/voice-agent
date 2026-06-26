"""v4.14.5 — Latest live regression tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("VOICE_AGENT_RUNTIME_MODE", "main_llm_agent")

from app.agent_runtime.commerce_session import (
    ProductCandidate,
    clear_commerce_session,
    get_commerce_session,
    update_candidates_from_facts,
)
from app.agent_runtime.followup_context_resolver import resolve_followup_context
from app.agent_runtime.main_llm_agent import decide_and_answer
from app.agent_runtime.tool_entity_extractor import extract_tool_entities
from app.config import get_settings


def _session():
    from app.state.models import SessionState

    s = SessionState(
        session_id="sess4145live",
        call_sid="CA4145LIVE",
        from_number="+15551234567",
        to_number="+15559876543",
    )
    clear_commerce_session(s.call_sid)
    commerce = get_commerce_session(s.call_sid)
    update_candidates_from_facts(commerce, [
        ProductCandidate(
            candidate_id="live1",
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
    s.last_product_candidate = {
        "candidate_id": "live1",
        "title": "The Grandparenting Blueprint",
        "isbn": "9798893960648",
        "product_id": "p1",
        "variant_id": "v1",
        "price": "$19.99",
    }
    return s


class TestLatestLiveRegression:
    @pytest.mark.asyncio
    async def test_isbn_then_price_no_catalog_search(self):
        session = _session()
        decision = await decide_and_answer(
            user_turn="Price.",
            session=session,
            settings=get_settings(),
        )
        assert decision["response_mode"] == "direct_answer"
        assert "$19.99" in decision["direct_answer"]
        assert "catalog_search" not in decision.get("tool_categories", [])

    @pytest.mark.asyncio
    async def test_price_noise_not_title_search(self):
        decision = await decide_and_answer(
            user_turn="I need price. What is the price?",
            settings=get_settings(),
        )
        assert decision.get("intent") != "book_title_search"
        entities = extract_tool_entities("I need price. What is the price?")
        assert "product_phrase" not in entities

    @pytest.mark.asyncio
    async def test_no_generic_repeat_for_price(self):
        session = _session()
        followup = resolve_followup_context("Price.", sid=session.call_sid, commerce=get_commerce_session(session.call_sid))
        assert "Could you say that one more time" not in (followup.direct_answer or "")

    @pytest.mark.asyncio
    async def test_no_animal_unrelated_search(self):
        entities = extract_tool_entities("I need price. What is the price?")
        assert entities.get("product_phrase", "").lower() != "price. what is the price"

    @pytest.mark.asyncio
    async def test_runtime_mode_main_llm(self, monkeypatch):
        # v4.18: the single active runtime is the LLM-first tool runtime.
        # Assert the code default (env-independent of process-global test pins).
        monkeypatch.delenv("VOICE_AGENT_RUNTIME_MODE", raising=False)
        from app.config import Settings
        assert Settings().VOICE_AGENT_RUNTIME_MODE == "llm_tool_runtime"

    @pytest.mark.asyncio
    async def test_no_legacy_runtime(self):
        assert get_settings().VOICE_AGENT_RUNTIME_MODE != "legacy_v410"

    @pytest.mark.asyncio
    async def test_openai_tools_blocked(self):
        assert get_settings().VOICE_LIVE_DISABLE_OPENAI_TOOLS is True

    @pytest.mark.asyncio
    async def test_out_of_stock_email_offer(self):
        from app.agent_runtime.tool_answer_composer import compose_answer_from_tool_facts
        from app.workers.base import WorkerBundle, WorkerResult

        bundle = WorkerBundle()
        bundle.results["product_search"] = WorkerResult(
            worker_name="product_search",
            success=True,
            data={"title": "Rare Book", "available": False, "inventory_quantity": 0},
        )
        answer = compose_answer_from_tool_facts("book_search", None, bundle)
        assert "out of stock" in answer.lower()
        assert "email" in answer.lower()

    @pytest.mark.asyncio
    async def test_not_listed_email_offer(self):
        from app.agent_runtime.tool_answer_composer import compose_answer_from_tool_facts
        from app.workers.base import WorkerBundle, WorkerResult

        bundle = WorkerBundle()
        bundle.results["product_isbn"] = WorkerResult(
            worker_name="product_isbn",
            success=True,
            data={"not_found": True},
        )
        answer = compose_answer_from_tool_facts("isbn_lookup", None, bundle)
        assert "don't see that book listed" in answer.lower()
        assert "customer service" in answer.lower()
