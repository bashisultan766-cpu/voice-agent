"""v4.12 — Memory-aware repeat and clarification tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


def _session():
    from app.state.models import SessionState
    return SessionState(
        session_id="s412r",
        call_sid="CA00000412R",
        from_number="+15550004127",
        to_number="+15559998888",
    )


@pytest.fixture(autouse=True)
def _llm_first_env(monkeypatch):
    monkeypatch.setenv("VOICE_FINAL_RESPONSE_MODE", "llm_first")
    monkeypatch.setenv("VOICE_FINAL_LLM_FOR_CLARIFICATION", "true")
    from app.config import get_settings
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class TestRepeatDetection:
    def test_repeat_phrases_detected(self):
        from app.agent_runtime.call_memory_manager import is_repeat_or_clarification_request

        assert is_repeat_or_clarification_request("What you say? You are what?")
        assert is_repeat_or_clarification_request("It's your what?")
        assert is_repeat_or_clarification_request("What did you say?")
        assert is_repeat_or_clarification_request("Say that again")
        assert is_repeat_or_clarification_request("What was your name")

    def test_memory_packet_contains_last_assistant(self):
        from app.agent_runtime.call_memory_manager import CallMemoryManager
        from app.conversation.call_memory import record_assistant_turn, record_user_turn

        session = _session()
        record_user_turn(session, "What is your name?", "identity_question")
        record_assistant_turn(
            session,
            "My name is Eric. I'm with SureShot Books.",
        )
        packet = CallMemoryManager.build_packet(session)
        assert "Eric" in packet.last_assistant_response
        ctx = packet.to_supervisor_context()
        assert "Last Eric response" in ctx


@pytest.mark.asyncio
class TestRepeatSupervisorAndComposer:
    async def test_supervisor_repeat_intent(self):
        from app.agent_runtime.llm_supervisor import get_supervisor
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.agent_runtime.types import StatePacket

        session = _session()
        from app.conversation.call_memory import record_assistant_turn, record_user_turn
        record_user_turn(session, "What is your name?", "identity_question")
        record_assistant_turn(session, "My name is Eric. I'm with SureShot Books.")

        d = await get_supervisor().decide(
            session, "What you say? You are what?", MemoryPacket(), StatePacket(),
        )
        assert d.user_intent == "repeat_clarification"

    async def test_repeat_uses_final_llm_with_memory(self):
        from unittest.mock import AsyncMock
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.workers.base import WorkerBundle
        from app.conversation.call_memory import record_assistant_turn, record_user_turn

        session = _session()
        record_user_turn(session, "What is your name?", "identity_question")
        record_assistant_turn(session, "My name is Eric. I'm with SureShot Books.")

        memory = MemoryPacket(
            last_assistant_response="My name is Eric. I'm with SureShot Books.",
            recent_turns=[("What is your name?", "My name is Eric. I'm with SureShot Books.")],
        )
        decision = SupervisorDecision(user_intent="repeat_clarification", response_strategy="repair")
        intent = IntentResult(intent="repeat_clarification", confidence=0.94)

        composer = get_final_composer()
        composer._composer.compose_final_response = AsyncMock(
            return_value="I said my name is Eric. I'm with SureShot Books.",
        )

        text, source = await composer.compose(
            session, "What you say? You are what?", decision, intent,
            memory, FactPacket(), WorkerBundle(),
        )
        assert source == "llm"
        assert "Eric" in text
        assert "I said" in text or "my name" in text.lower()

    async def test_what_did_you_say_repeats_last_question(self):
        from unittest.mock import AsyncMock
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.workers.base import WorkerBundle

        memory = MemoryPacket(
            last_assistant_response="Do you have the ISBN, title, author, or subject?",
            recent_turns=[("I need a book", "Do you have the ISBN, title, author, or subject?")],
        )
        decision = SupervisorDecision(user_intent="repeat_clarification")
        intent = IntentResult(intent="repeat_clarification", confidence=0.94)

        composer = get_final_composer()
        composer._composer.compose_final_response = AsyncMock(
            return_value="I asked if you have the ISBN, title, author, or subject.",
        )

        text, source = await composer.compose(
            _session(), "What did you say?", decision, intent,
            memory, FactPacket(), WorkerBundle(),
        )
        assert source == "llm"
        assert "ISBN" in text or "title" in text.lower()
