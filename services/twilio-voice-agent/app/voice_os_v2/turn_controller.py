"""
TurnController — single lock per call, strict v2.1 turn pipeline.

PolicyEngine → Planner → ToolChain → Composer → Emitter → commit
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any, Optional

from .memory_contract import (
    append_state_transition,
    append_tool_history,
    append_turn_record,
    build_tool_chain_log,
    derive_commit_patches,
    merge_tool_patches,
    snapshot_stage,
)
from .planner import Planner
from .policy_engine import PolicyEngine
from .response_composer import ResponseComposer
from .session_state import (
    V2SessionState,
    get_or_create_v2_session,
    load_v2_session,
    save_v2_session,
)
from .tool_executor import ToolExecutor
from .trace_logger import TraceLogger
from .types import PlanAction, ToolChainResult, ToolExecutionResult, TurnResult
from .voice_emitter import VoiceEmitter

logger = logging.getLogger(__name__)

SendFn = Callable[[dict], Awaitable[None]]

_MAX_TURN_HISTORY = 50
_MAX_TOOL_HISTORY = 100
_MAX_TRANSITIONS = 100


class TurnController:
    """
    Strict turn flow (v2.1):
      acquire lock → fetch Redis → policy → planner → tool chain →
      composer → emitter → commit → release lock
    """

    VERSION = "v2.1"

    def __init__(self, settings=None):
        from ..config import get_settings

        self._settings = settings or get_settings()
        self._policy = PolicyEngine()
        self._planner = Planner(self._settings)
        self._executor = ToolExecutor()
        self._composer = ResponseComposer(self._settings)
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock_for(self, call_sid: str) -> asyncio.Lock:
        if call_sid not in self._locks:
            self._locks[call_sid] = asyncio.Lock()
        return self._locks[call_sid]

    def release_call(self, call_sid: str) -> None:
        self._locks.pop(call_sid, None)

    async def on_user_turn(
        self,
        *,
        call_sid: str,
        user_text: str,
        send: SendFn,
        from_number: str = "",
        to_number: str = "",
        session_id: str = "",
    ) -> TurnResult:
        lock = self._lock_for(call_sid)
        if lock.locked():
            logger.info("v2_turn_queued_busy sid=%s — awaiting prior turn", call_sid[:6])
        async with lock:
            return await self._run_turn(
                call_sid=call_sid,
                user_text=user_text,
                send=send,
                from_number=from_number,
                to_number=to_number,
                session_id=session_id,
            )

    async def _run_turn(
        self,
        *,
        call_sid: str,
        user_text: str,
        send: SendFn,
        from_number: str,
        to_number: str,
        session_id: str,
    ) -> TurnResult:
        sid = call_sid[:6]
        text = (user_text or "").strip()

        state = await get_or_create_v2_session(
            call_sid=call_sid,
            from_number=from_number,
            to_number=to_number,
            session_id=session_id,
        )

        state.turn_id += 1
        turn_epoch = state.turn_id
        stage_before = snapshot_stage(state)

        trace = TraceLogger.start(call_sid, turn_epoch, text)
        trace.mark("lock_acquired")
        policy_patches: dict[str, Any] = {}

        policy_decision = self._policy.evaluate(state, text)
        trace.set_policy(policy_decision)
        trace.mark("policy", {"policy_id": policy_decision.policy_id})

        if policy_decision.overridden and policy_decision.plan:
            plan = policy_decision.plan
            policy_patches = dict(policy_decision.commit_patches or {})
        else:
            plan = await self._planner.run(state, text)
            gate = self._policy.gate_tool_plan(state, plan)
            if gate.overridden and gate.plan:
                plan = gate.plan
                policy_patches.update(gate.commit_patches or {})
                trace.mark("policy_gate", {"policy_id": gate.policy_id})

        trace.set_planner_plan(plan)
        trace.mark("planner", {"action": plan.action.value, "reason": plan.reason})

        tool_chain: ToolChainResult = ToolChainResult()
        last_tool: Optional[ToolExecutionResult] = None

        if plan.action == PlanAction.TOOL and plan.tool:
            tool_chain = await self._executor.run_chain(
                plan,
                state,
                self._planner,
                user_text=text,
                policy_gate=self._policy,
            )
            for step_result in tool_chain.results:
                trace.append_tool_step({
                    "step": step_result.step,
                    "tool": step_result.tool,
                    "ok": step_result.ok,
                    "error": step_result.error,
                })
            trace.mark("tool_chain", {
                "steps": tool_chain.steps_executed,
                "exit": tool_chain.exit_reason,
            })
            if tool_chain.results:
                last_tool = tool_chain.results[-1]

        composed = await self._composer.build(
            state, text, plan, last_tool, tool_chain=tool_chain,
        )
        trace.composed_chars = len(composed.text)
        trace.mark("composer")

        emitter = VoiceEmitter(send)

        async def _current_epoch() -> int:
            fresh = await load_v2_session(call_sid)
            return int(fresh.turn_id) if fresh else turn_epoch

        async def _interrupt_check() -> bool:
            fresh = await load_v2_session(call_sid)
            return bool(fresh and fresh.interrupt_flag)

        emit = await emitter.stream(
            composed.text,
            turn_epoch=turn_epoch,
            get_current_epoch=_current_epoch,
            is_interrupted=_interrupt_check,
        )
        trace.emit_discarded = emit.discarded
        trace.mark("emitter", {"discarded": emit.discarded, "chars": emit.chars})

        tool_patches = tool_chain.state_patches or merge_tool_patches(tool_chain.results)
        commit_patches = derive_commit_patches(
            state,
            plan,
            policy_patches=policy_patches,
            tool_patches=tool_patches,
        )

        if emit.discarded:
            trace_payload = trace.finish()
            append_turn_record(
                state,
                turn_id=turn_epoch,
                user_text=text,
                policy=trace.policy,
                planner_plan=trace.planner_plan,
                tool_chain=build_tool_chain_log(tool_chain.results),
                composed_text="",
                trace=trace_payload,
                commit_patches={},
                skipped=True,
            )
            if len(state.turn_history) > _MAX_TURN_HISTORY:
                state.turn_history = state.turn_history[-_MAX_TURN_HISTORY:]
            await save_v2_session(state)
            return TurnResult(
                response_text="",
                turn_id=turn_epoch,
                skipped=True,
                reason="emit_discarded",
            )

        state.apply_patches(commit_patches)
        if plan.stage_hint and not commit_patches.get("conversation_stage"):
            state.conversation_stage = plan.stage_hint

        stage_after = snapshot_stage(state)
        if stage_after != stage_before:
            append_state_transition(
                state,
                turn_id=turn_epoch,
                from_stage=stage_before,
                to_stage=stage_after,
                reason=plan.reason,
                patches=commit_patches,
            )

        append_tool_history(state, build_tool_chain_log(tool_chain.results))
        if len(state.tool_history) > _MAX_TOOL_HISTORY:
            state.tool_history = state.tool_history[-_MAX_TOOL_HISTORY:]
        if len(state.state_transitions) > _MAX_TRANSITIONS:
            state.state_transitions = state.state_transitions[-_MAX_TRANSITIONS:]

        state.last_response = composed.text
        state.interrupt_flag = False
        state.history.append({"role": "user", "content": text})
        state.history.append({"role": "assistant", "content": composed.text})
        if len(state.history) > 40:
            state.history = state.history[-40:]

        trace_payload = trace.finish()
        append_turn_record(
            state,
            turn_id=turn_epoch,
            user_text=text,
            policy=trace.policy,
            planner_plan=trace.planner_plan,
            tool_chain=build_tool_chain_log(tool_chain.results),
            composed_text=composed.text,
            trace=trace_payload,
            commit_patches=commit_patches,
        )
        if len(state.turn_history) > _MAX_TURN_HISTORY:
            state.turn_history = state.turn_history[-_MAX_TURN_HISTORY:]

        await save_v2_session(state)

        logger.info(
            "v2_turn_complete sid=%s turn_id=%d chars=%d ms=%d reason=%s",
            sid,
            turn_epoch,
            len(composed.text),
            trace_payload.get("total_ms", 0),
            plan.reason,
        )

        return TurnResult(
            response_text=composed.text,
            turn_id=turn_epoch,
            end_call=composed.end_call,
        )


_controller: Optional[TurnController] = None


def get_turn_controller(settings=None) -> TurnController:
    global _controller
    if _controller is None or settings is not None:
        _controller = TurnController(settings)
    return _controller
