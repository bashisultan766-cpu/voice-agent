"""Guided voice conversation state in voice_commerce_runtime."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from app.runtime.voice_commerce_runtime import (
    RUNTIME_MODE,
    VoiceCommerceRuntime,
    _GUIDED_AWAITING_ORDER_PROMPT,
)
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="guided",
        call_sid="CAguided123",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


def _runtime() -> VoiceCommerceRuntime:
    return VoiceCommerceRuntime(settings=type("S", (), {"OPENAI_API_KEY": "k"})())


def test_sync_sets_awaiting_on_order_intent():
    runtime = _runtime()
    session = _session()
    runtime._sync_voice_conversation_state(
        session, "I'd like to check an order.", turn_mode="",
    )
    assert session.voice_conversation["stage"] == "awaiting_order_number"
    assert session.voice_conversation["last_intent"] == "order_lookup"


def test_sync_sets_order_lookup_when_number_spoken():
    runtime = _runtime()
    session = _session(voice_conversation={"stage": "awaiting_order_number", "last_intent": "order_lookup", "last_order_id": None})
    runtime._sync_voice_conversation_state(
        session, "order number 47980", turn_mode="order",
    )
    assert session.voice_conversation["stage"] == "order_lookup"
    assert session.voice_conversation["last_order_id"] == "47980"


def test_enforce_awaiting_returns_fixed_prompt():
    runtime = _runtime()
    session = _session(voice_conversation={"stage": "awaiting_order_number", "last_intent": "order_lookup", "last_order_id": None})
    reply = runtime._enforce_awaiting_order_ux(session, "sure", turn_mode="")
    assert reply == _GUIDED_AWAITING_ORDER_PROMPT


def test_instant_order_prompt_uses_guided_text():
    runtime = _runtime()
    session = _session()
    send = AsyncMock()

    with patch.object(runtime._brain, "finalize_response", side_effect=lambda s, t, tr: t), patch(
        "app.runtime.voice_commerce_runtime.classify",
    ) as mock_classify:
        from app.runtime.fast_classifier import ClassificationResult

        mock_classify.return_value = ClassificationResult(
            action="instant",
            reason="order_collection_prompt",
            instant_reply="Sure, read your order number slowly.",
            skip_llm=True,
        )
        with patch.object(runtime, "_handle_email_fsm", return_value=None), patch.object(
            runtime._brain, "run_turn", return_value=("", [], []),
        ):
            result = asyncio.run(
                runtime.handle_turn(session, "I'd like to check an order.", send),
            )

    assert session.voice_conversation["stage"] == "awaiting_order_number"
    assert _GUIDED_AWAITING_ORDER_PROMPT.rstrip(".") in result.response_text.replace(".", "")


def test_completed_stage_replays_summary_only():
    runtime = _runtime()
    summary = "Order 47980 is paid and shipped."
    session = _session(
        voice_conversation={"stage": "completed", "last_intent": "order_lookup", "last_order_id": "47980"},
        order_last_voice_reply=summary,
    )
    send = AsyncMock()

    with patch.object(runtime._brain, "finalize_response", side_effect=lambda s, t, tr: t), patch(
        "app.runtime.voice_commerce_runtime.classify",
    ) as mock_classify:
        from app.runtime.fast_classifier import ClassificationResult

        mock_classify.return_value = ClassificationResult(action="brain", reason="test")
        with patch.object(runtime, "_handle_email_fsm", return_value=None):
            result = asyncio.run(
                runtime.handle_turn(session, "okay", send),
            )

    assert summary.rstrip(".") in result.response_text.replace(".", "")
    assert result.source == RUNTIME_MODE
