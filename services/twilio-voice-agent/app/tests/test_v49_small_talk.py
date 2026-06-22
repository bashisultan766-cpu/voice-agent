"""v4.9 — small talk worker and Eric policy responses."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.brain.eric_policy import build_composer_policy, get_small_talk_response
from app.composer.main_llm_composer import _deterministic_response
from app.pipeline.router import IntentResult
from app.state.models import SessionState
from app.workers.small_talk_worker import SmallTalkWorker


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="st", call_sid="CA_ST01",
        from_number="+1", to_number="+1",
        **kwargs,
    )


def _settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True)


class TestSmallTalkResponses:
    @pytest.mark.parametrize("intent,expected_fragment", [
        ("small_talk", "doing well"),
        ("identity_question", "Eric"),
        ("store_info_question", "SureShot Books"),
        ("keepalive_question", "I'm here"),
        ("frustration_repair", "slow down"),
    ])
    def test_exact_responses(self, intent, expected_fragment):
        text = get_small_talk_response(intent, _session())
        assert expected_fragment.lower() in text.lower()
        assert len(text.split()) <= 25

    def test_no_ai_mention(self):
        for intent in ("small_talk", "identity_question", "store_info_question"):
            text = get_small_talk_response(intent, _session())
            assert "ai" not in text.lower()
            assert "bot" not in text.lower()

    def test_no_privacy_refusal(self):
        text = get_small_talk_response("identity_question", _session())
        assert "cannot provide" not in text.lower()
        assert "personal information" not in text.lower()

    @pytest.mark.asyncio
    async def test_worker_returns_response(self):
        worker = SmallTalkWorker()
        r = await worker.run(_session(), {"intent": "small_talk"}, _settings())
        assert "doing well" in r.safe_summary.lower()

    def test_composer_policy_compact(self):
        policy = build_composer_policy()
        assert "Available Tools" not in policy
        assert "#" not in policy
        assert "Eric" in policy

    def test_deterministic_small_talk(self):
        ir = IntentResult(intent="identity_question", confidence=0.95)
        text = _deterministic_response(_session(), ir)
        assert "Eric" in text

    def test_resume_apology_once(self):
        s = _session(
            is_resumed_call=True,
            resume_greeting_pending=True,
            resume_greeting_delivered=False,
            resume_greeting="I'm sorry about that. Let me continue from where we left off.",
        )
        ir = IntentResult(intent="greeting", confidence=0.9)
        text = _deterministic_response(s, ir)
        assert "sorry" in text.lower()
        assert s.resume_greeting_delivered is True

    def test_second_how_are_you_not_resume(self):
        s = _session(
            is_resumed_call=True,
            resume_greeting_delivered=True,
            twiml_greeting_spoken=True,
        )
        ir = IntentResult(intent="small_talk", confidence=0.95)
        text = _deterministic_response(s, ir)
        assert "sorry" not in text.lower()
        assert "doing well" in text.lower()
