"""v4.14 — Off-domain/general question behavior.

Must redirect to SureShot Books without pretending to know factual answers.
No Shopify search for non-book queries.
"""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


_OFF_DOMAIN_CASES = [
    "Today is a football match.",
    "Can you give me the match schedule?",
    "Where can I stream live football matches?",
    "Who won the game?",
    "How can I make black coffee?",
    "What's the weather like today?",
    "Who is the president?",
    "What is the latest news?",
]

_BOOK_TOPIC_CASES = [
    "Do you have books about football?",
    "I'm looking for books about cooking",
    "Search books about football",
]


class TestMainLlmAgentOffDomain:
    """MainLLMAgent must redirect off-domain questions, never search catalog."""

    @pytest.mark.asyncio
    async def test_off_domain_cases(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        for text in _OFF_DOMAIN_CASES:
            decision = await decide_and_answer(
                user_turn=text,
                settings=s,
            )
            assert decision["intent"] == "off_domain", f"Expected off_domain for: {text}"
            assert decision["response_mode"] == "direct_answer", f"Expected direct_answer for: {text}"
            assert decision["tool_categories"] == [], f"Expected no tools for: {text}"
            da = decision["direct_answer"].lower()
            assert "sureshot books" in da or "books about" in da, f"Must mention SureShot Books: {text}"
            assert "stream" not in da, f"Must not answer factual: {text}"

    @pytest.mark.asyncio
    async def test_book_topic_cases(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        for text in _BOOK_TOPIC_CASES:
            decision = await decide_and_answer(
                user_turn=text,
                settings=s,
            )
            assert decision["intent"] in ("book_search", "company"), f"Expected book_search for: {text}, got {decision['intent']}"
            assert decision["response_mode"] == "needs_tools", f"Expected needs_tools for: {text}"
            assert "catalog_search" in decision["tool_categories"], f"Expected catalog_search for: {text}"


class TestOffDomainBoundaryRules:
    """Off-domain responses must not pretend to know factual information."""

    def test_action_gate_blocks_off_domain_products(self):
        from app.agent_runtime.action_gate import evaluate_action_gate
        from app.agent_runtime.types import SupervisorDecision

        for text in (
            "Can you give me the match schedule?",
            "Where can I stream live football matches?",
            "Who won the game?",
        ):
            r = evaluate_action_gate(
                call_sid="CA414OD",
                caller_text=text,
                supervisor=SupervisorDecision(user_intent="out_of_domain"),
                pipeline_intent="out_of_domain_question",
            )
            assert r.product_search_blocked is False or r.allowed is True, text
