"""Tests for VOICE_AGENT_OS_V2.1 production layers."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.voice_os_v2.memory_contract import derive_commit_patches
from app.voice_os_v2.planner import Planner
from app.voice_os_v2.policy_engine import PolicyEngine
from app.voice_os_v2.response_composer import ResponseComposer
from app.voice_os_v2.rules import evaluate_rules
from app.voice_os_v2.session_state import V2SessionState
from app.voice_os_v2.tool_executor import ToolExecutor, MAX_TOOL_CHAIN_STEPS
from app.voice_os_v2.trace_logger import TraceLogger
from app.voice_os_v2.turn_controller import TurnController
from app.voice_os_v2.types import Plan, PlanAction, ResponseMode, ToolExecutionResult


def test_policy_blocks_payment_without_email():
    engine = PolicyEngine()
    state = V2SessionState(call_sid="CA1", cart=[{"title": "Book", "quantity": 1}])
    decision = engine.evaluate(state, "send me the payment link")
    assert decision.overridden
    assert decision.plan is not None
    assert decision.plan.action == PlanAction.SPEAK
    assert "email" in decision.plan.instant_text.lower()


def test_policy_order_requires_number():
    engine = PolicyEngine()
    state = V2SessionState(call_sid="CA1")
    decision = engine.evaluate(state, "check my order status")
    assert decision.overridden
    assert "order number" in decision.plan.instant_text.lower()


def test_policy_cart_prioritization():
    engine = PolicyEngine()
    state = V2SessionState(
        call_sid="CA1",
        cart=[{"title": "Red River", "quantity": 1}],
        conversation_stage="idle",
    )
    decision = engine.evaluate(state, "I want a book about cooking")
    assert decision.overridden
    assert "cart" in decision.plan.instant_text.lower()


def test_planner_no_state_patches_from_llm_parse():
    planner = Planner()
    plan = planner._parse_llm_plan({
        "action": "tool",
        "tool": "catalog_search",
        "args": {"query": "test"},
        "stage_hint": "shopping",
        "response_mode": "tool_result",
    })
    assert plan.state_patches == {}


def test_trace_logger_stages():
    trace = TraceLogger.start("CAtrace", 1, "hello")
    trace.mark("policy", {"id": "pass"})
    trace.set_planner_plan(Plan(action=PlanAction.SPEAK, reason="greeting"))
    payload = trace.finish()
    assert payload["turn_id"] == 1
    assert len(payload["stages"]) >= 1
    assert payload["planner_plan"]["reason"] == "greeting"


def test_memory_contract_interrupt_clear():
    state = V2SessionState(call_sid="CA1")
    plan = Plan(action=PlanAction.SPEAK, reason="interrupt_repeat")
    patches = derive_commit_patches(state, plan, policy_patches={}, tool_patches={})
    assert patches.get("interrupt_flag") is False


@pytest.mark.asyncio
async def test_tool_chain_max_steps_and_duplicate_guard():
    executor = ToolExecutor()
    planner = MagicMock()
    planner.plan_tool_followup.side_effect = [
        Plan(
            action=PlanAction.TOOL,
            tool="add_to_cart",
            args={"variant_id": "v1", "quantity": 1},
        ),
        None,
    ]

    state = V2SessionState(call_sid="CAchain")
    initial = Plan(
        action=PlanAction.TOOL,
        tool="catalog_search",
        args={"query": "test"},
    )

    search_result = ToolExecutionResult(
        tool="catalog_search",
        ok=True,
        data={"results": [{"variant_id": "v1", "title": "Book"}]},
        state_patches={"metadata": {"last_product": {"variant_id": "v1"}}},
    )

    with patch.object(executor, "run", new_callable=AsyncMock) as mock_run:
        mock_run.side_effect = [
            search_result,
            ToolExecutionResult(tool="add_to_cart", ok=True, data={"success": True}),
        ]
        chain = await executor.run_chain(initial, state, planner, user_text="test")

    assert chain.steps_executed == 2
    assert chain.exit_reason == "followup_none"
    assert mock_run.call_count == 2


@pytest.mark.asyncio
async def test_turn_controller_records_turn_history():
    controller = TurnController()
    state = V2SessionState(call_sid="CAhist")

    async def send(msg):
        pass

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
                instant_text="Hello from v2.1",
                reason="test",
            ),
        )
        result = await controller.on_user_turn(
            call_sid="CAhist",
            user_text="hi",
            send=send,
        )

    assert result.response_text == "Hello from v2.1"
    assert len(state.turn_history) == 1
    assert state.turn_history[0]["composed_text"] == "Hello from v2.1"
    assert "trace" in state.turn_history[0]
