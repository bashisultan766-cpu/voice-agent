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
from .main_llm_agent import decide_and_answer as main_llm_agent_decide
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

        # v4.14: Main LLM Agent mode — direct LLM decision path
        if is_main_llm_agent_mode(settings):
            return await self._handle_main_llm_agent_turn(
                session, caller_text, send, caller_context, turn,
            )

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
        if not gate.allowed and gate.product_search_blocked:
            cs_result.state.blocked_product_search_count += 1
            preserved = gate.semantic_intent or pipeline_intent
            if preserved and preserved != pipeline_intent:
                router_result.intent = preserved
                pipeline_intent = preserved
            sup_user = decision.user_intent
            if preserved == "identity_question":
                sup_user = "identity"
            elif preserved in ("company_question", "job_question", "frustration_repair"):
                sup_user = preserved.replace("_question", "") if preserved.endswith("_question") else preserved
            if sup_user != decision.user_intent or decision.source != "action_gate":
                decision = SupervisorDecision(
                    user_intent=sup_user,
                    confidence=decision.confidence,
                    customer_mood=decision.customer_mood,
                    domain_boundary=decision.domain_boundary,
                    worker_requests=[],
                    should_answer_now=True,
                    response_strategy=(
                        "repair" if preserved == "frustration_repair" else "direct"
                    ),
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


    async def _handle_main_llm_agent_turn(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable[[dict], Awaitable[None]],
        caller_context: Optional["SafeCallerContext"] = None,
        turn=None,
    ) -> RuntimeTurnResult:
        """
        v4.14 Main LLM Agent turn handler.

        Every complete user turn goes to MainLLMAgent first.
        - direct_answer: sanitize + send immediately (no workers, no router, no composer).
        - needs_tools: run only requested workers, then Final LLM writes answer.
        """
        from ..safety.response_sanitizer import log_assistant_response, sanitize_customer_response
        from .call_memory_manager import CallMemoryManager
        from .fact_packet import build_fact_packet
        from .memory_packet import build_memory_packet
        from .prompt_loader import load_eric_system_prompt_text
        from ..dialogue.manager import DialogueManager

        settings = self._settings
        sid = session.call_sid[:6]
        t0 = time.monotonic()

        logger.info("main_llm_runtime_start sid=%s turn=%s", sid, caller_text[:40])

        memory = build_memory_packet(session, max_turns=settings.VOICE_MEMORY_TURNS)
        memory_context = memory.to_composer_context() if memory else ""

        from ..cart.session import get_ledger
        ledger = get_ledger(session)
        cart_summary = f"{ledger.confirmed_count()} confirmed book(s)" if ledger.confirmed_count() else ""

        email_state = "confirmed" if getattr(session, "confirmed_email", "") else (
            "pending" if getattr(session, "pending_email", "") else "none"
        )
        order_state = getattr(session, "last_order_number", "") or ""

        assistants = getattr(getattr(session, "call_memory", None), "assistant_turns", []) or []
        last_assistant = assistants[-1] if assistants else ""

        decision = await main_llm_agent_decide(
            user_turn=caller_text,
            session=session,
            memory_context=memory_context,
            last_assistant=last_assistant,
            cart_summary=cart_summary,
            email_state=email_state,
            order_state=order_state,
            settings=settings,
        )

        response_mode = decision["response_mode"]
        intent = decision["intent"]
        direct_answer = decision["direct_answer"]
        tool_categories = decision["tool_categories"]

        # ── direct_answer: immediate response, no workers ──────────────────────
        if response_mode == "direct_answer" and direct_answer:
            from ..safety.response_sanitizer import sanitize_customer_response
            sanitized = sanitize_customer_response(
                direct_answer,
                intent=intent,
                call_sid=session.call_sid,
            )
            text = sanitized.text
            await _await_send(send, {"type": "text", "token": text, "last": False, "interruptible": True})
            await _await_send(send, {"type": "text", "token": "", "last": True})
            log_assistant_response(text, call_sid=session.call_sid, intent=intent)
            from .conversation_state_machine import record_safe_response, clear_interrupt as clear_state_interrupt
            record_safe_response(session.call_sid, text)
            clear_state_interrupt(session.call_sid)
            CallMemoryManager.update_after_turn(session, caller_text, text, intent)
            logger.info("tool_fanout_skipped reason=direct_answer")
            total_ms = (time.monotonic() - t0) * 1000
            logger.info("main_llm_runtime_complete sid=%s total_ms=%.0f source=direct_answer", sid, total_ms)
            return RuntimeTurnResult(response_text=text, source="main_llm_direct")

        # ── needs_tools: run only requested workers ────────────────────────────
        if response_mode == "needs_tools" and tool_categories:
            logger.info("tool_fanout_started categories=%s", tool_categories)
            from ..workers.orchestrator import get_orchestrator
            from ..pipeline.router import IntentResult

            router_result = IntentResult(intent=intent, entities={})
            worker_bundle = await self._execute_main_llm_tools(
                tool_categories, router_result, session, settings,
            )
            fact_packet = build_fact_packet(worker_bundle, session)
            facts_n = len(fact_packet.customer_facing_facts)
            logger.info("tool_fanout_completed facts=%d", facts_n)

            # Final LLM writes answer with full system prompt + facts
            from ..composer.main_llm_composer import get_composer
            composer = get_composer(settings)
            system_prompt = load_eric_system_prompt_text()
            response_text = await self._compose_main_llm_answer(
                session, caller_text, decision, memory,
                fact_packet, worker_bundle, system_prompt, composer,
            )

            if response_text:
                from ..safety.response_sanitizer import sanitize_customer_response
                sanitized = sanitize_customer_response(
                    response_text,
                    intent=intent,
                    call_sid=session.call_sid,
                )
                response_text = sanitized.text
                await _await_send(send, {"type": "text", "token": response_text, "last": False, "interruptible": True})
                await _await_send(send, {"type": "text", "token": "", "last": True})
                log_assistant_response(response_text, call_sid=session.call_sid, intent=intent)
                from .conversation_state_machine import record_safe_response, clear_interrupt as clear_state_interrupt
                record_safe_response(session.call_sid, response_text)
                clear_state_interrupt(session.call_sid)
                CallMemoryManager.update_after_turn(session, caller_text, response_text, intent)

            total_ms = (time.monotonic() - t0) * 1000
            logger.info("main_llm_runtime_complete sid=%s total_ms=%.0f source=needs_tools", sid, total_ms)
            return RuntimeTurnResult(response_text=response_text or "", source="main_llm_tools")

        # ── hold / repair: skip turn ──────────────────────────────────────────
        if response_mode in ("hold", "repair"):
            logger.info("skip_turn sid=%s reason=main_llm_%s", sid, response_mode)
            return RuntimeTurnResult(skip_turn=True, skip_reason=f"main_llm_{response_mode}")

        # ── Fallback: send default answer ──────────────────────────────────────
        fallback = "How can I help you with SureShot Books today?"
        await _await_send(send, {"type": "text", "token": fallback, "last": False, "interruptible": True})
        await _await_send(send, {"type": "text", "token": "", "last": True})
        CallMemoryManager.update_after_turn(session, caller_text, fallback, intent)
        return RuntimeTurnResult(response_text=fallback, source="main_llm_fallback")

    async def _execute_main_llm_tools(
        self,
        tool_categories: list[str],
        router_result,
        session: "SessionState",
        settings,
    ):
        """Execute only the requested tool categories in parallel."""
        from ..workers.orchestrator import get_orchestrator
        from ..workers.base import WorkerBundle, WorkerResult

        orchestrator = get_orchestrator()

        tool_to_intents = {
            "catalog_search": "book_topic_allowed",
            "isbn_lookup": "isbn_search",
            "order_lookup": "order_lookup",
            "refund_lookup": "refund_detail",
            "shipping_lookup": "shipping_question",
            "facility_approval": "facility_approval",
            "facility_restriction": "facility_restriction",
            "store_info": "store_info_question",
            "cart_memory": "memory_summary_question",
            "address_update": "address_update",
            "cancellation": "cancellation_request",
            "email_capture": "email_provided",
            "payment_flow": "send_payment_link",
            "escalation": "escalation",
        }

        worker_name_to_tool = {
            "catalog_search": "catalog_search",
            "isbn_lookup": "isbn_lookup",
            "order_lookup": "order_lookup",
            "refund_lookup": "refund_lookup",
            "shipping_lookup": "shipping_lookup",
            "facility_approval": "facility_approval",
            "facility_restriction": "facility_restriction",
            "store_info": "store_info",
            "cart_memory": "cart_memory",
            "address_update": "address_update",
            "cancellation": "cancellation",
            "email_capture": "email_capture",
            "payment_flow": "payment_flow",
            "escalation": "escalation",
        }

        from ..pipeline.router import IntentResult
        intent_map = {}
        for cat in tool_categories:
            intent_map[cat] = tool_to_intents.get(cat, "unknown")

        primary_intent = intent_map.get(tool_categories[0], "unknown") if tool_categories else "unknown"
        router_result.intent = primary_intent
        router_result.entities["intent"] = primary_intent

        from ..workers.orchestrator import _INTENT_WORKERS, _REGISTRY, _run_one
        import asyncio
        import time

        timeout_secs = settings.VOICE_TOOL_TIMEOUT_MS / 1000
        t0 = time.monotonic()
        bundle = WorkerBundle()

        all_worker_names = []
        for cat in tool_categories:
            tool = worker_name_to_tool.get(cat, cat)
            wns = _INTENT_WORKERS.get(primary_intent, [tool])
            all_worker_names.extend(wns)

        all_worker_names = list(dict.fromkeys(all_worker_names))
        bundle.workers_ran = list(all_worker_names)

        if not all_worker_names:
            bundle.total_ms = 0.0
            return bundle

        tasks = {
            name: asyncio.create_task(
                _run_one(name, session, router_result.entities, settings, timeout_secs),
                name=f"worker-{name}",
            )
            for name in all_worker_names
            if name in _REGISTRY
        }

        results = await asyncio.gather(*tasks.values(), return_exceptions=True)

        for name, result in zip(tasks.keys(), results):
            if isinstance(result, WorkerResult):
                bundle.results[name] = result
            else:
                bundle.results[name] = WorkerResult(
                    worker_name=name,
                    success=False,
                    error_code="orchestrator_error",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="none",
                )

        bundle.total_ms = (time.monotonic() - t0) * 1000
        return bundle

    async def _compose_main_llm_answer(
        self,
        session: "SessionState",
        caller_text: str,
        decision: dict,
        memory,
        fact_packet,
        worker_bundle,
        system_prompt: str,
        composer,
    ) -> str:
        """Write final answer using full Eric prompt + tool facts."""
        from ..agent_runtime.eric_master_policy import build_eric_final_response_system_prompt
        from openai import AsyncOpenAI
        import asyncio

        settings = self._settings
        sid = session.call_sid[:6]
        model = settings.VOICE_FINAL_MODEL
        timeout = settings.VOICE_FINAL_TIMEOUT_MS / 1000

        worker_ctx = worker_bundle.to_llm_context(
            verified_email=getattr(session, "verified_email", ""),
            verified_phone=getattr(session, "verified_phone", ""),
        )
        fact_ctx = fact_packet.to_composer_context() if fact_packet else ""
        memory_ctx = memory.to_composer_context() if memory else ""

        intent = decision.get("intent", "unknown")
        tool_categories = decision.get("tool_categories", [])
        tool_reason = decision.get("tool_reason", "")

        user_prompt = (
            f"Customer turn: {caller_text}\n\n"
            f"Intent: {intent}\n"
            f"Tool categories requested: {tool_categories}\n"
            f"Tool reason: {tool_reason}\n\n"
            f"Call memory:\n{memory_ctx}\n\n"
            f"Worker facts (use only if present — never invent):\n{worker_ctx}\n"
        )
        if fact_ctx:
            user_prompt += f"\nApproved facts:\n{fact_ctx}\n"
        user_prompt += (
            "\nWrite one short natural spoken response as Eric. "
            "Stay inside SureShot Books. No JSON. No markdown."
        )

        memory_turns = len(memory.recent_turns) if memory else 0
        facts_n = len(fact_packet.customer_facing_facts) if fact_packet else 0
        logger.info(
            "main_llm_final_request sid=%s intent=%s model=%s memory_turns=%d facts=%d",
            sid, intent, model, memory_turns, facts_n,
        )

        client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
        final_system = build_eric_final_response_system_prompt()
        full_prompt = f"{system_prompt}\n\n{final_system}\n\nUse the tool facts above for orders, shipping, refunds, inventory, facility, cancellation, and payment. Never guess business facts."

        try:
            resp = await asyncio.wait_for(
                client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": full_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    temperature=0.65,
                    max_tokens=150,
                ),
                timeout=timeout,
            )
            text = (resp.choices[0].message.content or "").strip()
            logger.info(
                "main_llm_final_response sid=%s intent=%s chars=%d",
                sid, intent, len(text),
            )
            return text
        except Exception:
            logger.exception("main_llm_final_error sid=%s", sid)
            return ""


_runtime: EricAgentRuntime | None = None


def get_eric_runtime(settings=None) -> EricAgentRuntime:
    global _runtime
    from ..config import get_settings
    s = settings or get_settings()
    if _runtime is None:
        _runtime = EricAgentRuntime(settings=s)
    else:
        _runtime._settings = s
    return _runtime


def is_eric_runtime_mode(settings=None) -> bool:
    from ..config import get_settings
    s = settings or get_settings()
    return s.VOICE_AGENT_RUNTIME_MODE == "eric_agent_runtime"


def is_main_llm_agent_mode(settings=None) -> bool:
    from ..config import get_settings
    s = settings or get_settings()
    return s.VOICE_AGENT_RUNTIME_MODE == "main_llm_agent"


def resolve_live_turn_handler(settings=None) -> str:
    """Return the configured live WebSocket turn handler label."""
    from ..config import get_settings
    s = settings or get_settings()
    return s.VOICE_AGENT_RUNTIME_MODE
