"""v4.12 — LLM-first final speaker tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")

_FALLBACK = "I'm here. How can I help you with SureShot Books today?"


def _session():
    from app.state.models import SessionState
    return SessionState(
        session_id="s412",
        call_sid="CA00000412",
        from_number="+15550004126",
        to_number="+15559998888",
    )


@pytest.fixture(autouse=True)
def _llm_first_env(monkeypatch):
    monkeypatch.setenv("VOICE_FINAL_RESPONSE_MODE", "llm_first")
    monkeypatch.setenv("VOICE_FINAL_LLM_FOR_SMALL_TALK", "true")
    monkeypatch.setenv("VOICE_FINAL_LLM_FOR_UNKNOWN", "true")
    monkeypatch.setenv("VOICE_FINAL_LLM_FOR_OUT_OF_DOMAIN", "true")
    monkeypatch.setenv("VOICE_FINAL_LLM_FOR_CLARIFICATION", "true")
    from app.config import get_settings
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.mark.asyncio
class TestV412LLMNaturalFinalSpeaker:
    async def test_small_talk_uses_final_llm(self, caplog):
        from unittest.mock import AsyncMock
        import logging
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.workers.base import WorkerBundle

        caplog.set_level(logging.INFO)
        session = _session()
        decision = SupervisorDecision(user_intent="small_talk")
        intent = IntentResult(intent="small_talk", confidence=0.9)

        composer = get_final_composer()
        composer._composer.compose_final_response = AsyncMock(
            return_value="I'm doing well, thank you. How can I help you today?",
        )

        text, source = await composer.compose(
            session, "Hello. How are you?", decision, intent,
            MemoryPacket(), FactPacket(), WorkerBundle(),
        )
        assert source == "llm"
        assert "final_llm_request" in caplog.text or composer._composer.compose_final_response.called
        assert _FALLBACK not in text

    async def test_unknown_uses_final_llm_not_generic(self, caplog):
        from unittest.mock import AsyncMock
        import logging
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.workers.base import WorkerBundle

        caplog.set_level(logging.INFO)
        session = _session()
        decision = SupervisorDecision(user_intent="unknown")
        intent = IntentResult(intent="unknown", confidence=0.3)

        composer = get_final_composer()
        composer._composer.compose_final_response = AsyncMock(
            return_value=(
                "I may have heard that wrong. Are you asking about a book, an order, "
                "or a payment link?"
            ),
        )

        text, source = await composer.compose(
            session, "Did what would would what?", decision, intent,
            MemoryPacket(), FactPacket(), WorkerBundle(),
        )
        assert source == "llm"
        assert text != _FALLBACK
        assert "book" in text.lower() or "order" in text.lower()

    async def test_name_question_deterministic_v4131(self):
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.workers.base import WorkerBundle

        session = _session()
        decision = SupervisorDecision(user_intent="identity")
        intent = IntentResult(intent="identity_question", confidence=0.95)

        composer = get_final_composer()
        text, source = await composer.compose(
            session, "What is your name?", decision, intent,
            MemoryPacket(), FactPacket(), WorkerBundle(),
        )
        assert source == "deterministic"
        assert text == "My name is Eric. I'm with SureShot Books."

    async def test_critical_payment_remains_deterministic(self):
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.workers.base import WorkerBundle

        session = _session()
        session.payment_flow_result = {
            "ran": True,
            "email_sent": True,
            "safe_message": (
                "I sent the payment link to your email. On that link, you can enter the "
                "facility details, inmate details, and complete your order. "
                "Please check your inbox or spam folder."
            ),
        }
        decision = SupervisorDecision(user_intent="payment_execute")
        intent = IntentResult(intent="payment_execute", confidence=0.9)
        text, source = await get_final_composer().compose(
            session, "Send it", decision, intent,
            MemoryPacket(), FactPacket(), WorkerBundle(),
        )
        assert source == "deterministic"
        assert "facility details" in text.lower()

    async def test_llm_fallback_on_error(self, caplog):
        from unittest.mock import AsyncMock
        import logging
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.workers.base import WorkerBundle

        caplog.set_level(logging.INFO)
        session = _session()
        decision = SupervisorDecision(user_intent="unknown")
        intent = IntentResult(intent="unknown", confidence=0.2)

        composer = get_final_composer()
        composer._composer.compose_final_response = AsyncMock(return_value="")

        text, source = await composer.compose(
            session, "???", decision, intent,
            MemoryPacket(), FactPacket(), WorkerBundle(),
        )
        assert "final_llm_fallback" in caplog.text
        assert text == _FALLBACK or source == "deterministic"

    async def test_final_prompt_boundary_rules(self):
        from app.agent_runtime.eric_master_policy import build_eric_final_response_system_prompt
        prompt = build_eric_final_response_system_prompt()
        assert "Eric" in prompt
        assert "SureShot Books" in prompt
        assert "Available Tools" not in prompt
        assert "repeat" in prompt.lower() or "memory" in prompt.lower()
        assert "off-domain" in prompt.lower() or "general" in prompt.lower()

    async def test_no_prompt_in_logs(self, caplog):
        import logging
        from unittest.mock import AsyncMock, patch
        from app.composer.main_llm_composer import MainLLMComposer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.workers.base import WorkerBundle

        caplog.set_level(logging.INFO)
        session = _session()
        decision = SupervisorDecision(user_intent="small_talk")
        intent = IntentResult(intent="small_talk", confidence=0.9)

        composer = MainLLMComposer()
        mock_resp = type("R", (), {
            "choices": [type("Ch", (), {
                "message": type("M", (), {"content": "Hi there."})(),
            })()],
        })()

        with patch("app.composer.main_llm_composer.AsyncOpenAI") as mock_cls:
            mock_client = AsyncMock()
            mock_cls.return_value = mock_client
            mock_client.chat.completions.create = AsyncMock(return_value=mock_resp)
            await composer.compose_final_response(
                session, "hello", decision, intent,
                MemoryPacket(), FactPacket(), WorkerBundle(),
            )

        log_text = caplog.text.lower()
        assert "system prompt" not in log_text
        assert "available tools" not in log_text

