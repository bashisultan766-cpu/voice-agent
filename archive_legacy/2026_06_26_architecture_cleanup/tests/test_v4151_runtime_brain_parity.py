"""v4.15.1 — Runtime brain parity integration tests."""
from __future__ import annotations

import logging
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


def _settings(**overrides):
    from app.config import Settings

    defaults = dict(
        OPENAI_API_KEY="test",
        DEBUG=True,
        VOICE_AGENT_RUNTIME_MODE="main_llm_agent",
        ERIC_PROMPT_PACK_ENABLED=True,
    )
    defaults.update(overrides)
    return Settings(**defaults)


def _session():
    from app.state.models import SessionState

    return SessionState(
        session_id="s4151r",
        call_sid="CA4151RUN1",
        from_number="+15550004151",
        to_number="+15559998888",
    )


async def _run_turn(settings, user_text: str, *, caplog=None):
    from app.agent_runtime import runtime as runtime_module
    from app.ws.conversation_relay import dispatch_assembled_turn
    from app.ws.conversation_relay_sender import ConversationRelayOutbound, ConversationRelayStats

    runtime_module._runtime = None
    captured: list[dict] = []
    stats = ConversationRelayStats()

    async def capture(msg: dict):
        captured.append(msg)

    outbound = ConversationRelayOutbound(capture, settings, "CA4151RUN1", stats)
    outbound.set_turn(1)

    async def send(msg: dict):
        await outbound.engine_send(msg)

    session = _session()
    if caplog is not None:
        caplog.set_level(logging.INFO)

    await dispatch_assembled_turn(settings, session, user_text, send, caller_context=None)
    await outbound.flush()
    text = " ".join(m.get("token", "") for m in captured)
    return text, caplog


# v4.18: these asserted the quarantined brain runtime's hardcoded conversational
# phrasing through the live dispatch path. Dispatch now routes to the LLM-first
# runtime, where the wording is composed by OpenAI, so these fixed-string
# assertions no longer apply. Kept (skipped) for historical traceability.
_OBSOLETE = "v4.18: replaced by LLM-first runtime (see test_v418_llm_tool_runtime)"


@pytest.mark.asyncio
class TestRuntimeBrainParity:
    @pytest.mark.skip(reason=_OBSOLETE)
    async def test_how_are_you_direct_no_tools(self, caplog):
        text, _ = await _run_turn(_settings(), "How are you?", caplog=caplog)
        assert "let me check" not in text.lower()
        assert "help" in text.lower()

    @pytest.mark.skip(reason=_OBSOLETE)
    async def test_what_can_you_do_capabilities(self):
        text, _ = await _run_turn(_settings(), "What can you do?")
        assert "let me check" not in text.lower()
        assert "SureShot" in text or "books" in text.lower()

    @pytest.mark.skip(reason=_OBSOLETE)
    async def test_are_you_there_direct(self):
        text, _ = await _run_turn(_settings(), "Are you there?")
        assert "let me check" not in text.lower()
        assert "here" in text.lower()

    @pytest.mark.skip(reason=_OBSOLETE)
    async def test_can_you_hear_me_direct(self):
        text, _ = await _run_turn(_settings(), "Can you hear me?")
        assert "let me check" not in text.lower()
        assert "hear" in text.lower()

    @pytest.mark.skip(reason=_OBSOLETE)
    async def test_newspaper_vague_clarification(self):
        text, _ = await _run_turn(_settings(), "Can you give me newspaper?")
        assert "let me check" not in text.lower()
        assert "which" in text.lower() or "newspaper" in text.lower()

    async def test_main_llm_receives_prompt_pack(self, caplog):
        with patch("app.agent_runtime.main_llm_agent.load_eric_system_prompt_text") as mock_prompt:
            mock_prompt.return_value = "PACK_TEST_MARKER Eric SureShot"
            mock_resp = AsyncMock()
            mock_resp.choices = [
                AsyncMock(
                    message=AsyncMock(
                        content='{"response_mode":"direct_answer","intent":"unknown",'
                        '"confidence":0.9,"direct_answer":"Hello there.","tool_categories":[]}'
                    )
                )
            ]
            mock_client = AsyncMock()
            mock_client.chat.completions.create = AsyncMock(return_value=mock_resp)

            with patch("app.agent_runtime.main_llm_agent.AsyncOpenAI", return_value=mock_client):
                from app.agent_runtime.main_llm_agent import decide_and_answer

                await decide_and_answer(user_turn="Tell me something random xyz123")

            assert mock_prompt.called
            call_args = mock_client.chat.completions.create.call_args
            system_msg = call_args.kwargs["messages"][0]["content"]
            assert "PACK_TEST_MARKER" in system_msg

    async def test_llm_needs_tools_blocked_for_greeting(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        mock_resp = AsyncMock()
        mock_resp.choices = [
            AsyncMock(
                message=AsyncMock(
                    content='{"response_mode":"needs_tools","intent":"unknown",'
                    '"confidence":0.5,"direct_answer":"Let me check on that.",'
                    '"tool_categories":["catalog_search"]}'
                )
            )
        ]
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_resp)

        with patch("app.agent_runtime.main_llm_agent.AsyncOpenAI", return_value=mock_client):
            decision = await decide_and_answer(user_turn="How are you?")

        assert decision["response_mode"] in ("direct_answer", "clarify")
        assert decision["tool_categories"] == []
        assert "let me check" not in decision.get("direct_answer", "").lower()

    async def test_usa_today_allows_tools_via_fast_or_business_path(self):
        from app.agent_runtime.main_llm_agent import decide_and_answer

        with patch("app.agent_runtime.main_llm_agent.AsyncOpenAI") as mock_client:
            decision = await decide_and_answer(
                user_turn="I need USA Today 5 day delivery for 3 months.",
            )
        assert decision["response_mode"] == "needs_tools" or decision["tool_categories"]

    async def test_openai_live_tools_remain_blocked(self):
        s = _settings()
        assert s.VOICE_LIVE_DISABLE_OPENAI_TOOLS is True

    async def test_payment_safety_guard_unchanged(self):
        from app.payment.safety import require_payment_send_ready, require_confirmed_cart

        from app.state.models import SessionState

        session = SessionState(
            session_id="s",
            call_sid="CAtest",
            from_number="+1",
            to_number="+2",
        )
        cart_result = require_confirmed_cart(session)
        assert not cart_result.allowed
        pay_result = require_payment_send_ready(session)
        assert not pay_result.allowed
