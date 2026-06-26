"""
Orchestrator runtime — modular voice agent (default live path Step 4+).
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable, Optional, TYPE_CHECKING

from ..memory.memory_manager import MemoryManager
from ..observability.otel import span
from ..observability.turn_latency import TurnLatency
from .conversation_manager import begin_turn
from .parallel_executor import execute_plan
from .planner_agent import run_planner
from .progress_ack import resolve_progress_message, should_send_progress_ack
from .response_composer import compose_response, should_skip_composer_llm
from .intent_router import classify_intent_heuristic, is_fast_path_supervisor_result
from .supervisor_agent import run_supervisor
from .types import OrchestratorTurnContext

if TYPE_CHECKING:
    from ..config import Settings
    from ..state.models import SafeCallerContext, SessionState

logger = logging.getLogger(__name__)

RUNTIME_MODE = "orchestrator"

_OPENAI_FALLBACK = (
    "I'm sorry, I'm having trouble right now. "
    "Could you repeat that, or would you like me to connect you with our team?"
)


def _result(answer: str, source: str = RUNTIME_MODE):
    from ..agent_runtime.types import RuntimeTurnResult

    return RuntimeTurnResult(response_text=answer, source=source)


async def _await_send(send: Callable, msg: dict) -> None:
    out = send(msg)
    if asyncio.iscoroutine(out):
        await out


class OrchestratorRuntime:
    """Modular orchestrated turn handler."""

    def __init__(self, settings: Optional["Settings"] = None) -> None:
        from ..config import get_settings

        self._settings = settings or get_settings()

    async def handle_turn(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable[[dict], Awaitable[None]],
        caller_context: Optional["SafeCallerContext"] = None,
        turn=None,
        *,
        assembled_turn_mode: str = "",
        stt_to_turn_ms: float = 0.0,
    ):
        sid = (session.call_sid or "")[:6]
        t0 = time.monotonic()
        latency = TurnLatency(stt_to_turn_ms=stt_to_turn_ms)
        turn_mode = assembled_turn_mode or getattr(turn, "mode", "") or ""

        logger.info(
            "orchestrator_start sid=%s turn_mode=%s text=%r",
            sid,
            turn_mode or "normal",
            caller_text[:60],
        )

        memory = MemoryManager.load(session)

        from ..agent_runtime.payment_flow_state import process_payment_turn

        payment_hint = process_payment_turn(session, caller_text, turn_mode=turn_mode)
        if payment_hint.force_reply:
            spoken = self._finalize(session, payment_hint.force_reply)
            MemoryManager.record_turn(session, caller_text, spoken, source=RUNTIME_MODE)
            await self._stream(send, spoken)
            latency.total_turn_ms = (time.monotonic() - t0) * 1000
            latency.log(call_sid=session.call_sid or "", handler=RUNTIME_MODE)
            return _result(spoken)

        if payment_hint.email_confirmed:
            from ..agent_runtime.llm_tool_runtime import LLMToolRuntime

            helper = LLMToolRuntime(settings=self._settings)
            return await helper._execute_payment_auto_send(
                session,
                caller_text,
                send,
                sid=sid,
                stage="orchestrator_auto_send",
            )

        from ..agent_runtime.not_found_escalation_flow import (
            process_not_found_escalation_turn,
        )

        escalation_hint = await process_not_found_escalation_turn(
            session, caller_text, turn_mode=turn_mode
        )
        if escalation_hint.force_reply:
            spoken = self._finalize(session, escalation_hint.force_reply)
            MemoryManager.record_turn(session, caller_text, spoken, source=RUNTIME_MODE)
            await self._stream(send, spoken)
            latency.total_turn_ms = (time.monotonic() - t0) * 1000
            latency.log(call_sid=session.call_sid or "", handler=RUNTIME_MODE)
            return _result(spoken)

        from ..agent_runtime.commerce_flow_state import advance_commerce_state_silent

        advance_commerce_state_silent(session, caller_text)

        from ..agent_runtime.interruption_manager import try_interrupt_repair

        last_spoken = getattr(session, "last_spoken_response", "") or ""
        handled, repair_text, _ = try_interrupt_repair(
            session.call_sid or "",
            caller_text,
            last_safe_response=last_spoken,
        )
        if handled and repair_text:
            spoken = self._finalize(session, repair_text)
            MemoryManager.record_turn(session, caller_text, spoken, source=RUNTIME_MODE)
            await self._stream(send, spoken)
            latency.total_turn_ms = (time.monotonic() - t0) * 1000
            latency.log(call_sid=session.call_sid or "", handler=RUNTIME_MODE)
            return _result(spoken)

        ctx = begin_turn(session, caller_text, turn_mode=turn_mode)
        ctx.memory_summary = memory.safe_summary

        from ..workflow.hooks import schedule_workflow_event

        schedule_workflow_event(
            session,
            "user_turn_received",
            {"text_len": len(caller_text or ""), "turn_mode": turn_mode},
            turn_id=ctx.turn_id,
        )

        t_sup = time.monotonic()
        with span("supervisor", call_sid=sid):
            pre_heuristic = classify_intent_heuristic(
                caller_text, session, turn_mode=turn_mode
            )
            if is_fast_path_supervisor_result(pre_heuristic):
                supervisor = pre_heuristic
            else:
                supervisor = await run_supervisor(
                    session,
                    caller_text,
                    memory_summary=ctx.memory_summary,
                    turn_mode=turn_mode,
                    settings=self._settings,
                    use_llm=bool(self._settings.OPENAI_API_KEY),
                )
        latency.supervisor_ms = (time.monotonic() - t_sup) * 1000
        ctx.supervisor = supervisor
        schedule_workflow_event(
            session,
            "supervisor_result",
            supervisor.to_dict(),
            turn_id=ctx.turn_id,
        )

        if supervisor.clarifying_question:
            spoken = self._finalize(session, supervisor.clarifying_question)
            MemoryManager.record_turn(session, caller_text, spoken, source=RUNTIME_MODE)
            await self._stream(send, spoken)
            latency.total_turn_ms = (time.monotonic() - t0) * 1000
            latency.log(call_sid=session.call_sid or "", handler=RUNTIME_MODE)
            return _result(spoken)

        progress_threshold = int(
            getattr(self._settings, "VOICE_ORCHESTRATOR_TOOL_PROGRESS_MS", 400) or 400
        )

        if supervisor.needs_tools and supervisor.needs_planner:
            t_plan = time.monotonic()
            with span("planner", call_sid=sid, intent=supervisor.intent):
                planner = await run_planner(
                    supervisor,
                    caller_text,
                    session,
                    memory_summary=ctx.memory_summary,
                    settings=self._settings,
                )
            latency.planner_ms = (time.monotonic() - t_plan) * 1000
            ctx.planner = planner
            schedule_workflow_event(
                session,
                "planner_result",
                planner.to_dict(),
                turn_id=ctx.turn_id,
            )

            if planner.blocked:
                spoken = self._finalize(
                    session,
                    planner.customer_message or "I need a bit more information first.",
                )
                MemoryManager.record_turn(session, caller_text, spoken, source=RUNTIME_MODE)
                await self._stream(send, spoken)
                latency.total_turn_ms = (time.monotonic() - t0) * 1000
                latency.log(call_sid=session.call_sid or "", handler=RUNTIME_MODE)
                return _result(spoken)

            if planner.customer_facing_progress_message or should_send_progress_ack(
                session, turn_mode=turn_mode, supervisor=supervisor
            ):
                progress_msg = resolve_progress_message(
                    supervisor, planner, caller_text
                )
                if progress_msg and should_send_progress_ack(
                    session, turn_mode=turn_mode, supervisor=supervisor
                ):
                    await _await_send(
                        send,
                        {
                            "type": "text",
                            "token": progress_msg,
                            "last": False,
                            "interruptible": True,
                        },
                    )

            t_tools = time.monotonic()
            with span("tool_execution", call_sid=sid):
                ctx.tool_results = await execute_plan(
                    planner,
                    session,
                    turn_id=ctx.turn_id,
                    timeout_ms=int(getattr(self._settings, "VOICE_TOOL_TIMEOUT_MS", 2500) or 2500),
                )
            latency.tool_total_ms = (time.monotonic() - t_tools) * 1000
            latency.tool_router_ms = latency.tool_total_ms

            if latency.tool_total_ms >= progress_threshold and not planner.customer_facing_progress_message:
                await _await_send(
                    send,
                    {
                        "type": "text",
                        "token": "Thanks for waiting — I'm still checking that.",
                        "last": False,
                        "interruptible": True,
                    },
                )

            from ..agent_runtime.not_found_escalation_flow import (
                handle_search_not_found_results,
            )

            nf_hint = await handle_search_not_found_results(
                session, ctx, settings=self._settings
            )
            if nf_hint.extra_tool_result is not None:
                ctx.tool_results.append(nf_hint.extra_tool_result)
            if nf_hint.force_reply:
                spoken = self._finalize(session, nf_hint.force_reply)
                MemoryManager.record_turn(session, caller_text, spoken, source=RUNTIME_MODE)
                await self._stream(send, spoken)
                latency.total_turn_ms = (time.monotonic() - t0) * 1000
                latency.log(call_sid=session.call_sid or "", handler=RUNTIME_MODE)
                return _result(spoken)

        t_comp = time.monotonic()
        with span("response_composer", call_sid=sid):
            spoken = await compose_response(
                session,
                ctx,
                settings=self._settings,
                use_llm=bool(self._settings.OPENAI_API_KEY)
                and not should_skip_composer_llm(ctx, session),
            )
        latency.response_composer_ms = (time.monotonic() - t_comp) * 1000
        schedule_workflow_event(
            session,
            "composer_result",
            {"response_len": len(spoken or ""), "tool_count": len(ctx.tool_results)},
            turn_id=ctx.turn_id,
        )

        spoken = self._finalize(session, spoken)

        from ..agent_runtime.payment_flow_state import enforce_payment_response
        from ..agent_runtime.commerce_flow_state import enforce_commerce_response

        tool_pairs = [(r.tool, r.result) for r in ctx.tool_results]
        if tool_pairs:
            spoken = enforce_payment_response(session, spoken, tool_pairs)
            spoken = enforce_commerce_response(session, spoken, tool_pairs)

        MemoryManager.record_turn(
            session, caller_text, spoken, source=RUNTIME_MODE, turn_id=ctx.turn_id
        )
        session.last_spoken_response = spoken
        schedule_workflow_event(
            session,
            "response_sent",
            {"response_len": len(spoken or "")},
            turn_id=ctx.turn_id,
        )
        await self._stream(send, spoken)

        latency.total_turn_ms = (time.monotonic() - t0) * 1000
        latency.log(call_sid=session.call_sid or "", handler=RUNTIME_MODE)

        logger.info(
            "orchestrator_complete sid=%s intent=%s tools=%d",
            sid,
            supervisor.intent,
            len(ctx.tool_results),
        )
        return _result(spoken)

    def _finalize(self, session: "SessionState", text: str) -> str:
        from ..agent_runtime.output_guardrails import apply_output_guardrails
        from ..agent_runtime.tool_runtime_gates import replace_blocked_order_phrase

        cleaned = replace_blocked_order_phrase(text or "")
        return apply_output_guardrails(cleaned).text

    async def _stream(self, send: Callable, spoken: str) -> None:
        await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
        await _await_send(send, {"type": "text", "token": "", "last": True})


_runtime: Optional[OrchestratorRuntime] = None


def get_orchestrator_runtime(settings=None) -> OrchestratorRuntime:
    global _runtime
    if _runtime is None:
        _runtime = OrchestratorRuntime(settings=settings)
    elif settings is not None:
        _runtime._settings = settings
    return _runtime


def orchestrator_enabled(settings=None) -> bool:
    from ..config import get_settings

    s = settings or get_settings()
    return bool(getattr(s, "VOICE_ORCHESTRATOR_ENABLED", True))
