"""v4.13 — Live regression replay from production defect logs."""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


def _session():
    from app.state.models import SessionState
    return SessionState(
        session_id="s413live",
        call_sid="CA00000413L",
        from_number="+15550004130",
        to_number="+15559998888",
    )


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("VOICE_FINAL_RESPONSE_MODE", "llm_first")
    monkeypatch.setenv("VOICE_FINAL_LLM_FOR_SMALL_TALK", "true")
    monkeypatch.setenv("VOICE_FINAL_LLM_FOR_CLARIFICATION", "true")
    monkeypatch.setenv("VOICE_FINAL_LLM_FOR_UNKNOWN", "true")
    monkeypatch.setenv("VOICE_LLM_BRAIN_ENABLED", "false")
    from app.config import get_settings
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def _run_turn(engine, session, text, *, final_text="Eric response."):
    from app.tests.eric_composer_mocks import patch_eric_runtime_composer
    from app.workers.base import WorkerBundle
    sent = []

    async def _send(msg):
        sent.append(msg)

    with patch_eric_runtime_composer(
        engine,
        final_text=final_text,
        worker_bundle=WorkerBundle(),
    ):
        await engine.handle_turn(session, text, _send)
    return sent


def _candidate_count(session) -> int:
    from app.cart.session import get_ledger
    ledger = get_ledger(session)
    return len([i for i in ledger.items if i.confirmation_status == "candidate"])


@pytest.mark.asyncio
class TestLatestLiveDefects:
    async def test_full_regression_sequence(self, caplog):
        import logging
        from app.pipeline.engine import RealtimePipelineEngine
        from app.config import Settings

        caplog.set_level(logging.INFO)
        engine = RealtimePipelineEngine(settings=Settings(OPENAI_API_KEY="test", DEBUG=True))
        session = _session()

        sequence = [
            ("Hello, brother. How are you?", "small_talk"),
            ("I am good. What is your name, brother?", "identity"),
            ("Your short short book.", "blocked"),
            ("What?", "repeat"),
            ("No. You are with ShowShort Books today?", "company"),
            ("You are not social book assistant.", "blocked"),
            ("No. I am asking you are the SureShort book assistant?", "company"),
            ("I need a book.", "vague"),
            ("Wait. Yes I have ISBN number. Wait. I will give you.", "hold"),
        ]

        for text, _kind in sequence:
            await _run_turn(engine, session, text)
            assert _candidate_count(session) == 0, f"candidate saved on: {text}"

        assert not getattr(session, "last_action_gate_approved", True) or _candidate_count(session) == 0
        assert "action_gate_blocked" in caplog.text or "product_search_blocked" in caplog.text

    async def test_identity_turn_no_product_search(self):
        from app.agent_runtime.action_gate import evaluate_action_gate
        from app.agent_runtime.types import SupervisorDecision

        r = evaluate_action_gate(
            call_sid="CA00000413L",
            caller_text="Your short short book.",
            supervisor=SupervisorDecision(user_intent="book_search"),
            pipeline_intent="product_search",
            router_hint="product_search",
        )
        assert r.allowed is False

    async def test_blocked_product_search_uses_final_llm_not_fallback(self):
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.workers.base import WorkerBundle

        session = _session()
        session.last_action_gate_result = {
            "allowed": False,
            "reason": "agent_identity_or_generic",
            "blocked_worker": "product_search",
            "safe_intent": "company_question",
        }
        composer = get_final_composer()
        composer._composer.compose_final_response = AsyncMock(
            return_value="Yes, I'm Eric with SureShot Books.",
        )
        text, source = await composer.compose(
            session,
            "You are not social book assistant.",
            SupervisorDecision(user_intent="company_question", source="action_gate"),
            IntentResult(intent="company_question", confidence=0.9),
            MemoryPacket(),
            FactPacket(),
            WorkerBundle(),
            action_gate=session.last_action_gate_result,
        )
        assert source == "llm"
        assert "Eric" in text or "SureShot" in text
        assert text != "I'm here. How can I help you with SureShot Books today?"

    async def test_isbn_partial_clarification(self):
        from app.agent_runtime.conversation_state_machine import (
            clear_conversation_state, process_turn,
        )
        clear_conversation_state("CA00000413L")
        import time
        from app.agent_runtime.conversation_state_machine import get_conversation_state
        st = get_conversation_state("CA00000413L")
        st.mode = "isbn_collection"
        st.pending_isbn_digits = "978044117271"
        st.isbn_partial_since = time.monotonic() - 10
        r = process_turn(
            "CA00000413L", "", pipeline_intent="isbn_search",
            isbn_buffer="978044117271",
        )
        assert "twelve digits" in r.repair_response.lower()

    async def test_hello_exits_isbn_hold(self):
        from app.agent_runtime.conversation_state_machine import process_turn, clear_conversation_state
        clear_conversation_state("CA00000413L")
        from app.agent_runtime.conversation_state_machine import get_conversation_state
        st = get_conversation_state("CA00000413L")
        st.mode = "isbn_collection"
        st.pending_isbn_digits = "978044117271"
        r = process_turn("CA00000413L", "Hello?", pipeline_intent="keepalive_question")
        assert r.exit_collection is True
        assert "here" in r.repair_response.lower()

    async def test_frustration_exits_isbn_hold(self):
        from app.agent_runtime.conversation_state_machine import process_turn, clear_conversation_state
        clear_conversation_state("CA00000413L")
        from app.agent_runtime.conversation_state_machine import get_conversation_state
        st = get_conversation_state("CA00000413L")
        st.mode = "isbn_collection"
        r = process_turn("CA00000413L", "What the ****?", pipeline_intent="frustration_repair")
        assert r.exit_collection is True
