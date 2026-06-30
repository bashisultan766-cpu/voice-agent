"""Tests for VOICE_AGENT_OS_V2 core."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from app.voice_os_v2.planner import Planner
from app.voice_os_v2.response_composer import ResponseComposer
from app.voice_os_v2.rules import evaluate_rules
from app.voice_os_v2.session_state import V2SessionState
from app.voice_os_v2.turn_controller import TurnController
from app.voice_os_v2.types import Plan, PlanAction, ResponseMode
from app.voice_os_v2.voice_emitter import VoiceEmitter, _sentences


def test_sentences_split():
    parts = _sentences("Hello there. How can I help?")
    assert len(parts) == 2
    assert parts[0] == "Hello there."
    assert parts[1] == "How can I help?"


def test_rules_greeting():
    state = V2SessionState(call_sid="CA123")
    plan = evaluate_rules(state, "Hello")
    assert plan is not None
    assert plan.action == PlanAction.SPEAK
    assert "SureShot" in plan.instant_text


def test_rules_goodbye():
    state = V2SessionState(call_sid="CA123")
    plan = evaluate_rules(state, "That's all, goodbye")
    assert plan is not None
    assert plan.action == PlanAction.END_CALL


def test_rules_interrupt_repeat():
    state = V2SessionState(call_sid="CA123", interrupt_flag=True)
    state.last_response = "Your order is shipped."
    plan = evaluate_rules(state, "What did you say?")
    assert plan is not None
    assert plan.response_mode == ResponseMode.REPEAT_LAST


@pytest.mark.asyncio
async def test_planner_rules_first():
    planner = Planner()
    state = V2SessionState(call_sid="CAtest01")
    with patch.object(planner, "_llm_plan", new_callable=AsyncMock) as mock_llm:
        plan = await planner.run(state, "Hi there")
        mock_llm.assert_not_called()
    assert plan.reason == "greeting"


@pytest.mark.asyncio
async def test_voice_emitter_epoch_discard():
    sent: list[dict] = []
    epoch = {"value": 1}

    async def send(msg):
        sent.append(msg)

    async def get_epoch():
        return epoch["value"]

    emitter = VoiceEmitter(send)
    epoch["value"] = 2
    result = await emitter.stream(
        "First. Second.",
        turn_epoch=1,
        get_current_epoch=get_epoch,
    )
    assert result.discarded is True
    assert sent == []


@pytest.mark.asyncio
async def test_voice_emitter_sentence_level():
    sent: list[dict] = []

    async def send(msg):
        sent.append(msg)

    emitter = VoiceEmitter(send)
    result = await emitter.stream("One sentence. Two sentence.", turn_epoch=5)
    assert result.chars > 0
    assert len(sent) == 2
    assert sent[0]["last"] is False
    assert sent[1]["last"] is True


@pytest.mark.asyncio
async def test_composer_repeat_last():
    composer = ResponseComposer()
    state = V2SessionState(call_sid="CA1", last_response="Payment link sent.")
    plan = Plan(action=PlanAction.SPEAK, response_mode=ResponseMode.REPEAT_LAST)
    out = await composer.build(state, "Repeat", plan)
    assert "Payment link sent" in out.text


@pytest.mark.asyncio
async def test_turn_controller_lock_serializes():
    controller = TurnController()
    order: list[int] = []

    async def slow_send(msg):
        await asyncio.sleep(0.05)

    state = V2SessionState(call_sid="CAlock1")

    async def run_one(n: int):
        with patch(
            "app.voice_os_v2.turn_controller.get_or_create_v2_session",
            new_callable=AsyncMock,
            return_value=state,
        ), patch(
            "app.voice_os_v2.turn_controller.save_v2_session",
            new_callable=AsyncMock,
        ), patch.object(controller._policy, "evaluate") as mock_policy:
            from app.voice_os_v2.policy_engine import PolicyDecision

            mock_policy.return_value = PolicyDecision(
                overridden=True,
                plan=Plan(
                    action=PlanAction.SPEAK,
                    response_mode=ResponseMode.INSTANT,
                    instant_text=f"reply-{n}",
                    reason="test",
                ),
            )
            await controller.on_user_turn(
                call_sid="CAlock1",
                user_text=f"text-{n}",
                send=slow_send,
            )
            order.append(n)

    await asyncio.gather(run_one(1), run_one(2))
    assert order == [1, 2]
