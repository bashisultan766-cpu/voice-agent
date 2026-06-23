"""v4.10 — response guard tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.composer.main_llm_composer import _deterministic_response
from app.pipeline.response_guard import apply_response_guard
from app.pipeline.router import IntentResult
from app.state.models import SessionState
from app.workers.orchestrator import WorkerOrchestrator


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="guard", call_sid="CA_G01",
        from_number="+15551234567", to_number="+18005551234",
        twiml_greeting_spoken=True,
        **kwargs,
    )


def _settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True, VOICE_FILLER_AFTER_MS=0)


class TestResponseGuard:
    def test_identity_emits_response(self):
        text = apply_response_guard("", "identity_question", call_sid="CA_G01")
        assert "Eric" in text

    def test_unknown_emits_response(self):
        text = apply_response_guard("", "unknown", call_sid="CA_G01")
        assert "SureShot Books" in text

    def test_worker_noop_fallback(self):
        text = apply_response_guard("", "totally_unknown", call_sid="CA_G01")
        assert text

    def test_fragment_hold_no_response(self):
        text = apply_response_guard("", "identity_question", turn_holding=True)
        assert text == ""

    @pytest.mark.asyncio
    async def test_identity_full_pipeline(self):
        orch = WorkerOrchestrator()
        s = _session()
        ir = IntentResult(intent="identity_question", confidence=0.96, entities={"intent": "identity_question"})
        bundle = await orch.run(ir, s, _settings())
        text = _deterministic_response(s, ir)
        if not text:
            plan = s.response_plan or {}
            text = apply_response_guard("", "identity_question", response_plan=plan)
        assert text
        assert "Eric" in text
