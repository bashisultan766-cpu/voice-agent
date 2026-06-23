"""v4.14 — Product/book search behavior.

Product search only when LLM explicitly asks for catalog search.
No product search for identity, small talk, off-domain, or clarification turns.
"""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


class TestMainLlmAgentBookSearch:
    """MainLLMAgent must correctly decide when book search is needed."""

    @pytest.mark.asyncio
    async def test_i_need_a_book_asks_clarification(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="I need a book",
            settings=s,
        )
        assert decision["intent"] == "vague_book_request"
        assert decision["response_mode"] == "direct_answer"
        assert decision["tool_categories"] == []
        da = decision["direct_answer"].lower()
        assert any(w in da for w in ("isbn", "title", "author", "subject", "what kind", "type of book"))

    @pytest.mark.asyncio
    async def test_books_about_football_needs_tools(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="Do you have books about football?",
            settings=s,
        )
        assert decision["intent"] == "book_search"
        assert decision["response_mode"] == "needs_tools"
        assert "catalog_search" in decision["tool_categories"]

    @pytest.mark.asyncio
    async def test_search_books_about_football(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="Search books about football",
            settings=s,
        )
        assert decision["intent"] == "book_search"
        assert decision["response_mode"] == "needs_tools"
        assert "catalog_search" in decision["tool_categories"]

    @pytest.mark.asyncio
    async def test_book_called_black_coffee(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="The book is called Black Coffee",
            settings=s,
        )
        assert decision["intent"] in ("book_search", "isbn_lookup")
        assert "catalog_search" in decision["tool_categories"] or "isbn_lookup" in decision["tool_categories"]

    @pytest.mark.asyncio
    async def test_isbn_search(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="ISBN is 9780441172719",
            settings=s,
        )
        assert decision["intent"] == "isbn_lookup"
        assert decision["response_mode"] == "needs_tools"
        assert "isbn_lookup" in decision["tool_categories"]

    @pytest.mark.asyncio
    async def test_identity_no_product_search(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="What is your name?",
            settings=s,
        )
        assert decision["tool_categories"] == []

    @pytest.mark.asyncio
    async def test_small_talk_no_product_search(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="How are you doing today?",
            settings=s,
        )
        assert decision["tool_categories"] == []


class TestProductSearchWorkerNotCalled:
    """ProductSearchWorker must not be called for identity/small-talk/off-domain."""

    def test_action_gate_blocks_identity_product_search(self):
        from app.agent_runtime.action_gate import evaluate_action_gate
        from app.agent_runtime.types import SupervisorDecision

        r = evaluate_action_gate(
            call_sid="CA414B",
            caller_text="What is your name?",
            supervisor=SupervisorDecision(user_intent="identity"),
            pipeline_intent="identity_question",
        )
        assert r.product_search_blocked is False
        assert r.semantic_intent == "identity_question"

    def test_action_gate_identity_misroute_blocked(self):
        from app.agent_runtime.action_gate import evaluate_action_gate
        from app.agent_runtime.types import SupervisorDecision

        r = evaluate_action_gate(
            call_sid="CA414B",
            caller_text="What is your name?",
            supervisor=SupervisorDecision(user_intent="book_search"),
            pipeline_intent="product_search",
        )
        assert r.allowed is False
        assert r.product_search_blocked is True
        assert r.semantic_intent == "identity_question"
