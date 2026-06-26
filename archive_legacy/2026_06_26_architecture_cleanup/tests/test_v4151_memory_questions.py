"""v4.15.1 — Memory question behavior tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


def _session(**kwargs):
    from app.state.models import SessionState

    defaults = dict(
        session_id="s4151",
        call_sid="CA41510001",
        from_number="+15550004151",
        to_number="+15559998888",
    )
    defaults.update(kwargs)
    return SessionState(**defaults)


class TestMemoryQuestions:
    @pytest.mark.asyncio
    async def test_last_year_no_fake_memory(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(
            user_turn="I spoke with you last year, remember?",
        )
        assert decision["response_mode"] == "direct_answer"
        assert decision["tool_categories"] == []
        assert "let me check" not in decision["direct_answer"].lower()
        assert "details" in decision["direct_answer"].lower() or "help" in decision["direct_answer"].lower()

    @pytest.mark.asyncio
    async def test_remember_me_no_verified_memory(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        decision = await decide_and_answer(user_turn="Do you remember me?")
        assert decision["tool_categories"] == []
        assert "let me check" not in decision.get("direct_answer", "").lower()

    @pytest.mark.asyncio
    async def test_remember_me_with_verified_recent_call(self):
        from app.agent_runtime.call_memory_manager import CallMemoryManager
        from app.agent_runtime.main_llm_agent import decide_and_answer

        session = _session(
            is_resumed_call=True,
            resume_context_available=True,
        )
        session.prior_call_ended_at = __import__("time").time() - 300
        from app.conversation.call_memory import get_call_memory, sync_from_session

        sync_from_session(session)
        state = get_call_memory(session)
        state.current_topic = "order status"
        state.important_facts.append("customer asked about shipping")

        decision = await decide_and_answer(
            user_turn="Do you remember me?",
            session=session,
        )
        assert decision["intent"] == "memory_question"
        assert decision["tool_categories"] == []
        assert "let me check" not in decision["direct_answer"].lower()
        packet = CallMemoryManager.build_packet(session)
        assert packet.can_reference_prior_call

    def test_memory_packet_fields(self):
        from app.agent_runtime.call_memory_manager import CallMemoryManager

        session = _session(
            is_resumed_call=True,
            resume_context_available=True,
        )
        session.prior_call_ended_at = __import__("time").time() - 600
        from app.conversation.call_memory import get_call_memory, sync_from_session

        sync_from_session(session)
        get_call_memory(session).current_topic = "payment link"

        packet = CallMemoryManager.build_packet(session)
        assert packet.has_verified_recent_call
        assert packet.can_reference_prior_call
        assert packet.safe_memory_summary
