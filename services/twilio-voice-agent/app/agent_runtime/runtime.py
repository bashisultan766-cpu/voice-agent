"""
EricAgentRuntime — central call-turn orchestrator (v4.11).

Every complete customer turn flows through supervisor → workers → final composer.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable, Optional, TYPE_CHECKING

from ..pipeline.compound_intent import detect as detect_intent
from ..pipeline.router import IntentResult
from ..safety.response_sanitizer import log_assistant_response, sanitize_customer_response
from .call_memory_manager import CallMemoryManager
from .fact_packet import build_fact_packet
from .final_response_composer import FinalResponseComposer
from .llm_supervisor import get_supervisor, supervisor_intent_to_pipeline
from .memory_packet import build_memory_packet
from .types import RuntimeTurnResult, StatePacket, SupervisorDecision
from .action_gate import evaluate_action_gate
from .conversation_state_machine import (
    clear_conversation_state,
    get_conversation_state,
    process_turn as process_conversation_state,
    record_safe_response,
    clear_interrupt as clear_state_interrupt,
)
from .interruption_manager import try_interrupt_repair, record_interrupt as record_turn_interrupt

if TYPE_CHECKING:
    from ..state.models import SafeCallerContext, SessionState

logger = logging.getLogger(__name__)


async def _await_send(send: Callable, msg: dict) -> None:
    result = send(msg)
    if asyncio.iscoroutine(result):
        await result


def _apply_turn_latency(turn, worker_bundle) -> None:
    if turn is None or worker_bundle is None:
        return
    turn.tools_ms = getattr(worker_bundle, "total_ms", 0.0) or 0.0
    turn.shopify_api_ms = getattr(worker_bundle, "shopify_api_ms", 0.0) or 0.0
    turn.resend_api_ms = getattr(worker_bundle, "resend_api_ms", 0.0) or 0.0


def _build_state_packet(session: "SessionState") -> StatePacket:
    from ..dialogue.manager import DialogueManager
    from ..cart.session import get_ledger

    dlg = DialogueManager.get_state(session)
    ledger = get_ledger(session)
    assistants = getattr(getattr(session, "call_memory", None), "assistant_turns", []) or []

    return StatePacket(
        cart_count=ledger.confirmed_count(),
        email_state="confirmed" if getattr(session, "confirmed_email", "") else (
            "pending" if getattr(session, "pending_email", "") else "none"
        ),
        payment_stage=getattr(session, "payment_flow_status", "idle") or "idle",
        order_number=getattr(session, "last_order_number", "") or "",
        facility_name=getattr(session, "last_facility_name", "") or "",
        active_flow=dlg.active_flow or "",
        expected_next=dlg.expected_next or "",
        previous_assistant=assistants[-1] if assistants else "",
        resume_pending=bool(getattr(session, "resume_greeting_pending", False)),
        isbn_count=len(getattr(session, "isbn_history", []) or []),
    )


class EricAgentRuntime:
    """Single orchestrator for ElevenLabs-style Eric runtime."""

    def __init__(self, settings=None, orchestrator=None, composer=None):
        from ..config import get_settings
        from ..composer.main_llm_composer import get_composer
        from ..workers.orchestrator import get_orchestrator
        self._settings = settings or get_settings()
        self._supervisor = get_supervisor(self._settings)
        self._orchestrator = orchestrator or get_orchestrator()
        self._composer = FinalResponseComposer(
            settings=self._settings,
            composer=composer or get_composer(),
        )

    async def handle_turn(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable[[dict], Awaitable[None]],
        caller_context: Optional["SafeCallerContext"] = None,
        orchestrator=None,
        composer=None,
        turn=None,
    ) -> RuntimeTurnResult:
        settings = self._settings
        if orchestrator is not None:
            self._orchestrator = orchestrator
        if composer is not None:
            self._composer = FinalResponseComposer(settings=settings, composer=composer)
        sid = session.call_sid[:6]
        t0 = time.monotonic()
        logger.info("eric_runtime_start sid=%s turn=%s", sid, caller_text[:40])

        # Router hint only — not final authority
        router_result = detect_intent(caller_text, session)

        from ..dialogue.short_utterance_resolver import resolve_short_utterance
        short = resolve_short_utterance(
            caller_text, session, input_intent=router_result.intent,
        )
        if short.resolved and short.intent:
            router_result.intent = short.intent

        memory = build_memory_packet(session, max_turns=settings.VOICE_MEMORY_TURNS)
        state = _build_state_packet(session)
        CallMemoryManager.log_supervisor_use(session)

        decision = await self._supervisor.decide(
            session,
            caller_text,
            memory,
            state,
            router_intent=router_result.intent,
            router_entities=dict(router_result.entities),
        )
        session.last_supervisor_decision = decision

        pipeline_intent = supervisor_intent_to_pipeline(decision)
        if decision.entities:
            router_result.entities.update(decision.entities)
        router_result.intent = pipeline_intent
        router_result.confidence = decision.confidence

        # v4.13: interrupt repair before workers
        conv_state = get_conversation_state(session.call_sid)
        handled, repair_text, repair_type = try_interrupt_repair(
            session.call_sid,
            caller_text,
            last_safe_response=conv_state.last_safe_response,
        )
        if handled and repair_text:
            logger.info("interrupt_repair sid=%s repair_type=%s", sid, repair_type)
            sanitized = sanitize_customer_response(
                repair_text,
                intent="repeat_clarification",
                call_sid=session.call_sid,
            )
            await _await_send(send, {"type": "text", "token": sanitized.text, "last": False, "interruptible": True})
            await _await_send(send, {"type": "text", "token": "", "last": True})
            record_safe_response(session.call_sid, sanitized.text)
            clear_state_interrupt(session.call_sid)
            CallMemoryManager.update_after_turn(session, caller_text, sanitized.text, "repeat_clarification")
            return RuntimeTurnResult(response_text=sanitized.text, source="deterministic", supervisor=decision)

        # v4.13: conversation state machine
        cs_result = process_conversation_state(
            session.call_sid,
            caller_text,
            pipeline_intent=pipeline_intent,
            settings=settings,
            isbn_buffer=getattr(session, "isbn_buffer", ""),
        )
        if cs_result.clear_isbn_buffer:
            session.isbn_buffer = ""
        if cs_result.repair_response and cs_result.should_answer:
            text = sanitize_customer_response(
                cs_result.repair_response,
                intent=pipeline_intent,
                call_sid=session.call_sid,
            ).text
            await _await_send(send, {"type": "text", "token": text, "last": False, "interruptible": True})
            await _await_send(send, {"type": "text", "token": "", "last": True})
            record_safe_response(session.call_sid, text)
            CallMemoryManager.update_after_turn(session, caller_text, text, pipeline_intent)
            return RuntimeTurnResult(response_text=text, source="deterministic", supervisor=decision)
        if cs_result.should_hold and not cs_result.should_answer:
            logger.info("skip_turn sid=%s reason=state_machine_hold", sid)
            return RuntimeTurnResult(skip_turn=True, skip_reason="state_machine_hold", supervisor=decision)

        from ..pipeline.intent_contract import validate_intent_contract
        contract = validate_intent_contract(
            pipeline_intent,
            context={
                "product_phrase": router_result.entities.get("product_phrase", ""),
                "query": caller_text,
                "call_sid": session.call_sid,
            },
        )
        if contract.resolved_intent and contract.resolved_intent != pipeline_intent:
            router_result.intent = contract.resolved_intent
            pipeline_intent = contract.resolved_intent

        # v4.13: action gate — no worker from router hint alone
        from ..catalog.query_specificity import score_product_query_specificity
        spec = score_product_query_specificity(caller_text)
        gate = evaluate_action_gate(
            call_sid=session.call_sid,
            caller_text=caller_text,
            supervisor=decision,
            pipeline_intent=pipeline_intent,
            router_hint=router_result.intent,
            conversation_mode=cs_result.state.mode,
            expected_next=cs_result.state.expected_next,
            query_specificity_score=spec.score,
        )
        session.last_action_gate_approved = gate.allowed
        session.last_action_gate_result = gate.to_dict()
        if not gate.allowed and gate.safe_intent:
            router_result.intent = gate.safe_intent
            pipeline_intent = gate.safe_intent
            cs_result.state.blocked_product_search_count += 1
            decision = SupervisorDecision(
                user_intent=gate.safe_intent,
                confidence=decision.confidence,
                customer_mood=decision.customer_mood,
                domain_boundary=decision.domain_boundary,
                worker_requests=[],
                should_answer_now=True,
                response_strategy="repair" if gate.safe_intent == "frustration_repair" else "direct",
                source="action_gate",
            )
            session.last_supervisor_decision = decision

        from ..dialogue.manager import DialogueManager
        from ..dialogue.naturalness import NaturalnessController
        DialogueManager.process_turn(session, router_result, caller_text)
        NaturalnessController.apply_frustration(session, caller_text)

        from ..pipeline.engine import _apply_email_state, _apply_payment_state
        _apply_email_state(session, router_result)
        _apply_payment_state(session, router_result)

        from ..conversation.call_memory import extract_turn_facts
        extract_turn_facts(session, pipeline_intent, caller_text)

        if decision.should_wait_for_more_speech:
            logger.info("skip_turn sid=%s reason=supervisor_hold", sid)
            return RuntimeTurnResult(skip_turn=True, skip_reason="supervisor_hold", supervisor=decision)

        from ..voice.turn_taking import classify_turn, is_complete_isbn, is_complete_order_number
        dlg = DialogueManager.get_state(session)
        turn_ctx = classify_turn(
            caller_text,
            intent=pipeline_intent,
            active_flow=dlg.active_flow or "",
            settings=settings,
        )
        _direct_answer_intents = frozenset({
            "small_talk", "identity_question", "agent_name_question",
            "company_question", "company_origin_question", "job_question",
            "what_do_you_do", "keepalive_question", "greeting",
            "out_of_domain_question", "vague_book_request", "ending_thanks",
        })
        if turn_ctx.hold_response and pipeline_intent not in _direct_answer_intents:
            incomplete = False
            if turn_ctx.collecting_isbn and not is_complete_isbn(caller_text):
                incomplete = True
            elif turn_ctx.collecting_order and not is_complete_order_number(caller_text):
                incomplete = True
            elif turn_ctx.collecting_email and "@" not in caller_text and " dot " not in caller_text.lower():
                incomplete = True
            if incomplete:
                if decision.should_wait_for_more_speech:
                    logger.info("skip_turn sid=%s reason=supervisor_hold", sid)
                    return RuntimeTurnResult(skip_turn=True, skip_reason="supervisor_hold", supervisor=decision)
                filler = turn_ctx.hold_filler or "Go ahead, I'm listening."
                if filler:
                    await _await_send(send, {"type": "text", "token": filler, "last": False, "interruptible": True})
                    await _await_send(send, {"type": "text", "token": "", "last": True})
                    session.turn_taking_hold = True
                    logger.info("skip_turn sid=%s reason=incomplete_fragment_filler", sid)
                    return RuntimeTurnResult(
                        response_text=filler,
                        skip_turn=True,
                        skip_reason="incomplete_fragment",
                        supervisor=decision,
                    )

        worker_bundle = await self._orchestrator.run(router_result, session, settings)
        _apply_turn_latency(turn, worker_bundle)
        for name in [w.worker for w in decision.worker_requests if w.worker != "none"]:
            logger.info(
                "eric_worker_result sid=%s worker=%s status=delegated",
                sid, name,
            )
        logger.info(
            "eric_worker_fanout_start sid=%s workers=%d",
            sid, len(decision.worker_requests),
        )
        fact_packet = build_fact_packet(worker_bundle, session)
        logger.info("eric_fact_packet sid=%s facts=%d", sid, len(fact_packet.customer_facing_facts))
        CallMemoryManager.log_composer_use(session)

        response, source = await self._composer.compose(
            session,
            caller_text,
            decision,
            router_result,
            memory,
            fact_packet,
            worker_bundle,
            caller_context,
            action_gate=getattr(session, "last_action_gate_result", None),
        )

        if not response:
            from ..pipeline.response_guard import apply_response_guard
            response = apply_response_guard(
                "",
                pipeline_intent,
                call_sid=session.call_sid,
                response_plan=getattr(session, "response_plan", None),
            ) or ""

        if response:
            sanitized = sanitize_customer_response(
                response,
                intent=pipeline_intent,
                call_sid=session.call_sid,
                payment_sent=bool(
                    (getattr(session, "payment_flow_result", {}) or {}).get("email_sent")
                ),
            )
            response = sanitized.text
            await _await_send(send, {"type": "text", "token": response, "last": False, "interruptible": True})
            await _await_send(send, {"type": "text", "token": "", "last": True})
            log_assistant_response(response, call_sid=session.call_sid, intent=pipeline_intent)
            CallMemoryManager.update_after_turn(session, caller_text, response, pipeline_intent)
            record_safe_response(session.call_sid, response)
            clear_state_interrupt(session.call_sid)

        total_ms = (time.monotonic() - t0) * 1000
        logger.info("eric_runtime_complete sid=%s total_ms=%.0f", sid, total_ms)

        return RuntimeTurnResult(
            response_text=response,
            source=source,
            supervisor=decision,
        )


_runtime: EricAgentRuntime | None = None


def get_eric_runtime(settings=None) -> EricAgentRuntime:
    global _runtime
    if _runtime is None:
        _runtime = EricAgentRuntime(settings=settings)
    return _runtime


def is_eric_runtime_mode(settings=None) -> bool:
    from ..config import get_settings
    s = settings or get_settings()
    return s.VOICE_AGENT_RUNTIME_MODE == "eric_agent_runtime"
