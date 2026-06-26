"""v4.13.1 — Latest live regression replay."""
from __future__ import annotations

import os
from unittest.mock import AsyncMock

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


def _session():
    from app.state.models import SessionState
    return SessionState(
        session_id="s4131live",
        call_sid="CA00004131L",
        from_number="+15550004131",
        to_number="+15559998888",
    )


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("VOICE_LLM_BRAIN_ENABLED", "false")
    monkeypatch.setenv("VOICE_FINAL_RESPONSE_MODE", "llm_first")
    from app.config import get_settings
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def _run_turn(engine, session, text):
    from app.tests.eric_composer_mocks import patch_eric_runtime_composer
    from app.workers.base import WorkerBundle
    sent = []

    async def _send(msg):
        sent.append(msg)

    with patch_eric_runtime_composer(
        engine,
        final_text="unused",
        worker_bundle=WorkerBundle(),
    ):
        await engine.handle_turn(session, text, _send)
    response = "".join(
        m.get("token", "") for m in sent if m.get("type") == "text"
    ).strip()
    return sent, response


def _candidate_count(session) -> int:
    from app.cart.session import get_ledger
    ledger = get_ledger(session)
    return len([i for i in ledger.items if i.confirmation_status == "candidate"])


@pytest.mark.asyncio
class TestLatestLiveRegression:
    async def test_full_sequence(self, caplog):
        import logging
        from app.pipeline.engine import RealtimePipelineEngine
        from app.config import Settings

        caplog.set_level(logging.INFO)
        engine = RealtimePipelineEngine(settings=Settings(OPENAI_API_KEY="test", DEBUG=True))
        session = _session()

        expectations = [
            ("Hello, brother. How are you?", None),
            ("Hello. What's what is your name?", "My name is Eric. I'm with SureShot Books."),
            ("What is your name?", "My name is Eric. I'm with SureShot Books."),
            (
                "I'm not asking about your job.",
                "I understand. My name is Eric. I'm with SureShot Books.",
            ),
            ("I'm asking about what is your name.", "My name is Eric. I'm with SureShot Books."),
            ("You're not using l and m.", "I understand. Let me slow down"),
            ("Why are you not using a 11 model?", "I'm here to help with SureShot Books"),
        ]

        for text, expected_sub in expectations:
            sent, response = await _run_turn(engine, session, text)
            assert _candidate_count(session) == 0, text
            if expected_sub and response:
                assert expected_sub in response, (
                    f"{text!r} -> {response!r}"
                )
            if "name" in text.lower():
                assert response
                assert "Eric" in response
                assert "orders, shipping, refunds" not in response

        assert "product_candidate_saved" not in caplog.text
        assert "turn_assembler_hold sid=" not in caplog.text or "incomplete_isbn digits=2" not in caplog.text

    async def test_model_question_no_isbn_mode(self):
        from app.voice.turn_assembler import get_turn_assembler, clear_turn_assembler

        clear_turn_assembler("CA00004131L")
        asm = get_turn_assembler("CA00004131L")
        emitted = []

        async def _emit(t):
            emitted.append(t)

        await asm.ingest(
            "Why are you not using a 11 model?",
            _emit,
            call_sid="CA00004131L",
        )
        assert asm._state.mode == "normal"

    async def test_identity_not_company_in_composer(self):
        from app.agent_runtime.final_response_composer import get_final_composer
        from app.agent_runtime.types import SupervisorDecision
        from app.agent_runtime.fact_packet import FactPacket
        from app.agent_runtime.memory_packet import MemoryPacket
        from app.pipeline.router import IntentResult
        from app.workers.base import WorkerBundle

        session = _session()
        composer = get_final_composer()
        text, source = await composer.compose(
            session,
            "What is your name?",
            SupervisorDecision(user_intent="identity"),
            IntentResult(intent="identity_question", confidence=0.96),
            MemoryPacket(),
            FactPacket(),
            WorkerBundle(),
            action_gate={
                "allowed": True,
                "semantic_intent": "identity_question",
                "product_search_blocked": False,
                "blocked_worker": "",
            },
        )
        assert source == "deterministic"
        assert text == "My name is Eric. I'm with SureShot Books."
