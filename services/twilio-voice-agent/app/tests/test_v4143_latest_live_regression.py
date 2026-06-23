"""v4.14.3 — Latest live log regression: no generic unknown repeat."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")

_LIVE_FAILURE_PHRASES = [
    "So my what is your job?",
    "So I need a a book",
    "The title name is",
    "Can I give you the ISBN number?",
    "Can I give you the ISBN number of the book?",
    (
        "I'm asking that can I give you the ISBN number of book "
        "and then you find for me?"
    ),
    "Can you give me the book?",
    "Can you give me cricket match information?",
    "What is your name?",
    "Are you show short book assistant?",
]


class TestLatestLiveRegression:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("text", _LIVE_FAILURE_PHRASES)
    async def test_no_generic_didnt_understand(self, text):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings

        decision = await decide_and_answer(user_turn=text, settings=get_settings())
        answer = (decision.get("direct_answer") or "").lower()
        assert "didn't understand" not in answer, f"Generic repeat for: {text}"
        assert "could you repeat that" not in answer, f"Generic repeat for: {text}"

    @pytest.mark.asyncio
    async def test_job_not_company_intro(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings

        decision = await decide_and_answer(
            user_turn="So my what is your job?",
            settings=get_settings(),
        )
        assert decision["intent"] == "job_question"
        assert decision["direct_answer"].startswith("My job is to help you")

    @pytest.mark.asyncio
    async def test_identity_regression(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings

        decision = await decide_and_answer(
            user_turn="What is your name?",
            settings=get_settings(),
        )
        assert decision["direct_answer"] == "My name is Eric. I'm with SureShot Books."

    @pytest.mark.asyncio
    async def test_assistant_identity_regression(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings

        decision = await decide_and_answer(
            user_turn="Are you show short book assistant?",
            settings=get_settings(),
        )
        assert decision["intent"] == "assistant_identity"
        assert "Eric" in decision["direct_answer"]
        assert "SureShot Books assistant" in decision["direct_answer"]
