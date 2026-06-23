"""v4.11 — Final response composer tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


def _session():
    from app.state.models import SessionState
    return SessionState(
        session_id="s411fc",
        call_sid="CA00000414",
        from_number="+15550004444",
        to_number="+15559998888",
    )


@pytest.mark.asyncio
class TestFinalResponseComposer:
    async def test_out_of_domain_no_factual_answer(self):
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.workers.base import WorkerBundle

        session = _session()
        decision = SupervisorDecision(user_intent="out_of_domain")
        intent = IntentResult(intent="out_of_domain_question", confidence=0.9)
        text, source = await get_final_composer().compose(
            session, "Who is Donald Trump?", decision, intent,
            MemoryPacket(), FactPacket(), WorkerBundle(),
        )
        assert "trump" not in text.lower() or "catalog" in text.lower()
        assert source == "deterministic"

    async def test_no_processing_fee(self):
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.workers.base import WorkerBundle

        session = _session()
        session.payment_flow_result = {"ran": True, "email_sent": True, "safe_message": (
            "I sent the payment link to your email. On that link, you can enter the "
            "facility details, inmate details, and complete your order. "
            "Please check your inbox or spam folder."
        )}
        decision = SupervisorDecision(user_intent="payment_execute")
        intent = IntentResult(intent="payment_execute", confidence=0.9)
        text, _ = await get_final_composer().compose(
            session, "Send it", decision, intent,
            MemoryPacket(), FactPacket(), WorkerBundle(),
        )
        assert "processing fee" not in text.lower()
        assert "facility details" in text.lower()

    async def test_address_update_exact(self):
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.workers.base import WorkerBundle

        session = _session()
        decision = SupervisorDecision(user_intent="address_update")
        intent = IntentResult(intent="address_update", confidence=0.9)
        text, source = await get_final_composer().compose(
            session, "Update my address", decision, intent,
            MemoryPacket(), FactPacket(), WorkerBundle(),
        )
        assert "Jessica" in text
        assert source == "deterministic"

    async def test_vague_book_asks_one_question(self):
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.workers.base import WorkerBundle

        session = _session()
        decision = SupervisorDecision(
            user_intent="vague_book_request",
            response_strategy="ask_one_question",
            one_question_to_ask="Do you have the ISBN, title, author, or subject?",
        )
        intent = IntentResult(intent="vague_book_request", confidence=0.9)
        text, _ = await get_final_composer().compose(
            session, "I need a book", decision, intent,
            MemoryPacket(), FactPacket(), WorkerBundle(),
        )
        assert "ISBN" in text or "title" in text.lower()

    async def test_final_prompt_no_tool_heading(self):
        from app.agent_runtime.eric_master_policy import build_eric_final_response_system_prompt
        prompt = build_eric_final_response_system_prompt()
        assert "Available Tools" not in prompt
