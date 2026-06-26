"""v4.14 — Full live log regression.

Replays the latest live log sequence and verifies correct behavior.
"""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")

_LIVE_SEQUENCE = [
    "Hello. How are you,",
    "What is your name?",
    "I'm not asking about store name, brand name. I'm just about what is your name.",
    "Today is a football match.",
    "Can you give me the match schedule?",
    "Where I can stream live I can see live matches of football.",
]


class TestMainLlmAgentLiveSequence:
    """Replay the latest live sequence with MainLLMAgent."""

    @pytest.mark.asyncio
    async def test_live_sequence_correct_decisions(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        expected = [
            {"intent": "small_talk", "mode": "direct_answer", "tools": []},
            {"intent": "identity", "mode": "direct_answer", "tools": []},
            {"intent": "identity", "mode": "direct_answer", "tools": []},
            {"intent": "off_domain", "mode": "direct_answer", "tools": []},
            {"intent": "off_domain", "mode": "direct_answer", "tools": []},
            {"intent": "off_domain", "mode": "direct_answer", "tools": []},
        ]

        for i, text in enumerate(_LIVE_SEQUENCE):
            decision = await decide_and_answer(
                user_turn=text,
                settings=s,
            )
            exp = expected[i]
            assert decision["intent"] == exp["intent"], (
                f"Turn {i+1} ('{text[:30]}...'): expected intent={exp['intent']}, got {decision['intent']}"
            )
            assert decision["response_mode"] == exp["mode"], (
                f"Turn {i+1}: expected mode={exp['mode']}, got {decision['response_mode']}"
            )
            assert decision["tool_categories"] == exp["tools"], (
                f"Turn {i+1}: expected tools={exp['tools']}, got {decision['tool_categories']}"
            )

    @pytest.mark.asyncio
    async def test_turn2_identity_name(self):
        """Turn 2: 'What is your name?' must answer with Eric name."""
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="What is your name?",
            settings=s,
        )
        assert decision["intent"] == "identity"
        assert "My name is Eric" in decision["direct_answer"]
        assert "shipping, refunds" not in decision["direct_answer"].lower()

    @pytest.mark.asyncio
    async def test_turn3_name_clarification(self):
        """Turn 3: name clarification must produce Eric name, not company."""
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="I'm not asking about store name, brand name. I'm just about what is your name.",
            settings=s,
        )
        assert decision["intent"] == "identity"
        assert "My name is Eric" in decision["direct_answer"]
        assert decision["tool_categories"] == []

    @pytest.mark.asyncio
    async def test_turn4_off_domain(self):
        """Turn 4: sports mention must be off_domain."""
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="Today is a football match.",
            settings=s,
        )
        assert decision["intent"] == "off_domain"
        assert decision["direct_answer"].lower().startswith(("i mainly help", "i can", "i'm here", "i can help"))
        assert decision["tool_categories"] == []

    @pytest.mark.asyncio
    async def test_turn5_match_schedule(self):
        """Turn 5: match schedule must redirect, not answer."""
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="Can you give me the match schedule?",
            settings=s,
        )
        assert decision["intent"] == "off_domain"
        assert decision["tool_categories"] == []
        da_lower = decision["direct_answer"].lower()
        assert "sureshot" in da_lower or "books" in da_lower
        assert "schedule" not in da_lower

    @pytest.mark.asyncio
    async def test_turn6_live_stream(self):
        """Turn 6: stream query must redirect, not answer."""
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="Where I can stream live I can see live matches of football.",
            settings=s,
        )
        assert decision["intent"] == "off_domain"
        assert decision["tool_categories"] == []
        da_lower = decision["direct_answer"].lower()
        assert "sureshot" in da_lower or "books" in da_lower
        assert "stream" not in da_lower


class TestNoGenericFallback:
    """No repeated generic 'I'm here. How can I help you...' for specific queries."""

    def test_no_repeated_generic_company_for_name(self):
        """Company template must not be used for name questions."""
        from app.agent_runtime.eric_master_policy import DETERMINISTIC_TEMPLATES
        company = DETERMINISTIC_TEMPLATES["company_intro"]
        identity = DETERMINISTIC_TEMPLATES["identity_name"]

        assert "My name is Eric" in identity
        assert "My name is Eric" not in company
        assert "orders, shipping" in company
