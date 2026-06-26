"""v4.15.1 — LLM brain contract tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")


class TestLLMBrainContract:
    def test_is_fake_checking_phrase(self):
        from app.agent_runtime.llm_brain_contract import is_fake_checking_phrase

        assert is_fake_checking_phrase("Let me check on that.")
        assert is_fake_checking_phrase("One moment while I check.")
        assert not is_fake_checking_phrase("I'm doing well, thank you.")

    def test_direct_answer_clears_tool_categories(self):
        from app.agent_runtime.llm_brain_contract import validate_llm_decision
        from app.agent_runtime.main_llm_agent import AVAILABLE_TOOL_CATEGORIES

        d = validate_llm_decision(
            {
                "response_mode": "direct_answer",
                "intent": "small_talk",
                "direct_answer": "Hello!",
                "tool_categories": ["catalog_search"],
            },
            valid_tool_categories=frozenset(AVAILABLE_TOOL_CATEGORIES),
        )
        assert d["tool_categories"] == []

    def test_fake_checking_repaired_in_direct_answer(self):
        from app.agent_runtime.llm_brain_contract import validate_llm_decision
        from app.agent_runtime.main_llm_agent import AVAILABLE_TOOL_CATEGORIES

        d = validate_llm_decision(
            {
                "response_mode": "direct_answer",
                "intent": "small_talk",
                "direct_answer": "Let me check on that.",
                "tool_categories": [],
            },
            user_text="How are you?",
            valid_tool_categories=frozenset(AVAILABLE_TOOL_CATEGORIES),
        )
        assert "let me check" not in d["direct_answer"].lower()
        assert "help" in d["direct_answer"].lower()

    def test_needs_tools_without_categories_becomes_clarify(self):
        from app.agent_runtime.llm_brain_contract import validate_llm_decision
        from app.agent_runtime.main_llm_agent import AVAILABLE_TOOL_CATEGORIES

        d = validate_llm_decision(
            {
                "response_mode": "needs_tools",
                "intent": "unknown",
                "direct_answer": "",
                "tool_categories": [],
            },
            valid_tool_categories=frozenset(AVAILABLE_TOOL_CATEGORIES),
        )
        assert d["response_mode"] == "clarify"
        assert d["direct_answer"]
