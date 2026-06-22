"""v4.9 — EricDialogueBrain unit tests."""
from __future__ import annotations

import asyncio
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")

from app.brain.eric_dialogue_brain import EricDialogueBrain, _fast_path_decision
from app.config import Settings
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="brain", call_sid="CA_BRAIN01",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


def _settings(**kwargs) -> Settings:
    return Settings(
        OPENAI_API_KEY="test",
        DEBUG=True,
        VOICE_LLM_BRAIN_ENABLED=True,
        **kwargs,
    )


class TestEricBrainFastPath:
    def test_how_are_you_small_talk(self):
        d = _fast_path_decision("Hello. How are you?", "greeting", _session())
        assert d is not None
        assert d.intent == "small_talk"

    def test_name_identity(self):
        d = _fast_path_decision("What is your name?", "unknown", _session())
        assert d.intent == "identity_question"

    def test_origin_store_info(self):
        d = _fast_path_decision("Where are you from?", "unknown", _session())
        assert d.intent == "store_info_question"

    def test_keepalive(self):
        d = _fast_path_decision("Are you with me?", "unknown", _session())
        assert d.intent == "keepalive_question"

    def test_hello_during_cart_flow(self):
        from app.dialogue.manager import DialogueManager
        from app.dialogue.states import DialogueState
        s = _session()
        st = DialogueState(active_flow="cart_building")
        DialogueManager.set_state(s, st)
        d = _fast_path_decision("Hello?", "unknown", s)
        assert d.intent == "keepalive_question"

    def test_payment_phrase(self):
        d = _fast_path_decision("Send me the bill", "unknown", _session())
        assert d.intent == "send_payment_link"


class TestEricBrainAsync:
    @pytest.mark.asyncio
    async def test_brain_timeout_falls_back(self):
        brain = EricDialogueBrain(settings=_settings())
        with patch(
            "app.brain.eric_dialogue_brain._call_llm_brain",
            side_effect=asyncio.TimeoutError(),
        ):
            with patch(
                "app.brain.eric_dialogue_brain._fast_path_decision",
                return_value=None,
            ):
                decision = await brain.plan(_session(), "random gibberish xyz", "unknown")
        assert decision.intent == "unknown"
        assert decision.source == "fallback"

    @pytest.mark.asyncio
    async def test_no_openai_tools_in_brain_call(self):
        captured: dict = {}

        async def fake_create(**kwargs):
            captured.update(kwargs)
            msg = MagicMock()
            msg.choices = [MagicMock(message=MagicMock(content='{"intent":"unknown","confidence":0.5}'))]
            return msg

        brain = EricDialogueBrain(settings=_settings())
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(side_effect=fake_create)

        with patch("app.brain.eric_dialogue_brain.AsyncOpenAI", return_value=mock_client):
            with patch("app.brain.eric_dialogue_brain._fast_path_decision", return_value=None):
                await brain.plan(_session(), "something ambiguous here please", "unknown")

        assert "tools" not in captured
        assert captured.get("response_format") == {"type": "json_object"}

    @pytest.mark.asyncio
    async def test_short_resolver_bypasses_llm(self):
        brain = EricDialogueBrain(settings=_settings())
        decision = await brain.plan(
            _session(), "Yes.", "confirmation",
            short_resolved_intent="add_to_cart",
        )
        assert decision.intent == "add_to_cart"
        assert decision.source == "short_resolver"
