"""Regression: ISBN product hunt after order lookup must not crash (call CA672f)."""
from __future__ import annotations

from dataclasses import dataclass
from unittest.mock import AsyncMock, patch

import pytest

from app.agent_runtime.isbn_short_circuit import IsbnShortCircuitResult
from app.agent_runtime.order_flow_state import STATUS_IDLE
from app.runtime.voice_commerce_runtime import VoiceCommerceRuntime
from app.state.models import SessionState


@dataclass
class _FakeSettings:
    OPENAI_API_KEY: str = "sk-test-not-real"
    OPENAI_MODEL: str = "gpt-4o"
    OPENAI_FAST_MODEL: str = "gpt-4o-mini"
    OPENAI_STRONG_MODEL: str = "gpt-4o"
    VOICE_OPENAI_TIMEOUT_MS: int = 8000
    VOICE_MAX_REPLY_WORDS: int = 50
    VOICE_PROMPT_TOKEN_BUDGET: int = 4000
    VOICE_TOOL_TIMEOUT_MS: int = 2500
    VOICE_COMMERCE_RUNTIME_ENABLED: bool = True
    VOICE_ORCHESTRATOR_ENABLED: bool = False
    VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED: bool = True


def _session() -> SessionState:
    session = SessionState(
        session_id="ca672f",
        call_sid="CA672fce7c600bbc311e9d3d3276c1a3fb",
        from_number="+1",
        to_number="+2",
    )
    session.last_order_number = "47999"
    session.order_last_voice_reply = "I found your order."
    session.order_flow_status = STATUS_IDLE
    session.twiml_greeting_spoken = True
    return session


@pytest.mark.asyncio
async def test_isbn_turn_after_order_lookup_speaks():
    runtime = VoiceCommerceRuntime(settings=_FakeSettings())
    session = _session()
    sent: list[dict] = []

    async def send(msg: dict) -> None:
        sent.append(msg)

    sc = IsbnShortCircuitResult(
        force_reply="I found Atomic Habits for eighteen dollars.",
        isbn="9781544503547",
    )

    with patch(
        "app.agent_runtime.isbn_short_circuit.try_isbn_short_circuit",
        new_callable=AsyncMock,
        return_value=sc,
    ):
        result = await runtime.handle_turn(
            session,
            "9781544503547.",
            send,
            assembled_turn_mode="isbn",
        )

    assert result is not None
    assert "atomic habits" in (result.response_text or "").lower()
