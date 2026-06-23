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

        from .pending_tool_state import handle_pending_tool_status_query
        expected_next_pre = getattr(getattr(session, "dialogue", None), "expected_next", "") or ""
        pending_reply = handle_pending_tool_status_query(
            session.call_sid, caller_text, expected_next=expected_next_pre,
        )
        if pending_reply:
            sanitized = sanitize_customer_response(
                pending_reply, intent="pending_tool_status", call_sid=session.call_sid,
            )
            text = sanitized.text
            await _await_send(send, {"type": "text", "token": text, "last": False, "interruptible": True})
            await _await_send(send, {"type": "text", "token": "", "last": True})
            log_assistant_response(text, call_sid=session.call_sid, intent="pending_tool_status")
            from .conversation_state_machine import record_safe_response, clear_interrupt as clear_state_interrupt
            record_safe_response(session.call_sid, text)
            clear_state_interrupt(session.call_sid)
            CallMemoryManager.update_after_turn(session, caller_text, text, "pending_tool_status")
            return RuntimeTurnResult(response_text=text, source="pending_tool_status")

        from .brand_alias_normalizer import normalize_brand_aliases
        from .followup_context_resolver import followup_result_to_decision, resolve_followup_context
        from .commerce_commit_resolver import resolve_commerce_commit
        from .commerce_session import get_commerce_session, save_commerce_session, sync_commerce_to_session_state

        commerce = get_commerce_session(session.call_sid)
        sync_commerce_to_session_state(commerce, session)

        followup = resolve_followup_context(
            caller_text,
            sid=session.call_sid,
            session_state=session,
            commerce=commerce,
        )

        brand = normalize_brand_aliases(caller_text)
        turn_text = brand.canonical_text if brand.matched else caller_text

        commit = resolve_commerce_commit(turn_text, commerce, session_state=session)

        skip_main_llm = False
        response_mode = ""
        intent = ""
        direct_answer = ""
        tool_categories: list[str] = []
        expected_next = ""

        if commit.matched and commit.response_mode != "pass_through":
            if commit.response_mode == "needs_tools" and commit.tool_categories:
                skip_main_llm = True
                response_mode = "needs_tools"
                intent = commit.intent
                direct_answer = commit.direct_answer or ""
                tool_categories = list(commit.tool_categories)
                expected_next = commit.expected_next or ""
            elif commit.direct_answer:
                sanitized = sanitize_customer_response(
                    commit.direct_answer,
                    intent=commit.intent,
                    call_sid=session.call_sid,
                )
                text = sanitized.text
                commerce.last_tool_answer = text
                if commit.intent.startswith(("product", "cart", "payment", "multi")):
                    commerce.last_product_answer = text
                if commit.expected_next:
                    commerce.expected_next = commit.expected_next
                    if hasattr(session, "dialogue"):
                        session.dialogue.expected_next = commit.expected_next
                save_commerce_session(commerce)
                sync_commerce_to_session_state(commerce, session)
                await _await_send(send, {"type": "text", "token": text, "last": False, "interruptible": True})
                await _await_send(send, {"type": "text", "token": "", "last": True})
                log_assistant_response(text, call_sid=session.call_sid, intent=commit.intent)
                from .conversation_state_machine import record_safe_response, clear_interrupt as clear_state_interrupt
                record_safe_response(session.call_sid, text)
                clear_state_interrupt(session.call_sid)
                CallMemoryManager.update_after_turn(session, caller_text, text, commit.intent)
                logger.info("tool_fanout_skipped reason=commerce_commit")
                total_ms = (time.monotonic() - t0) * 1000
                logger.info("main_llm_runtime_complete sid=%s total_ms=%.0f source=commerce_commit", sid, total_ms)
                return RuntimeTurnResult(response_text=text, source="commerce_commit")

        elif followup.resolved and followup.response_mode == "direct_answer" and followup.direct_answer:
            sanitized = sanitize_customer_response(
                followup.direct_answer,
                intent=followup.intent,
                call_sid=session.call_sid,
            )
            text = sanitized.text
            commerce.last_product_answer = text if followup.intent.startswith("product") else commerce.last_product_answer
            commerce.last_tool_answer = text
            if followup.expected_next:
                commerce.expected_next = followup.expected_next
                if hasattr(session, "dialogue"):
                    session.dialogue.expected_next = followup.expected_next
            save_commerce_session(commerce)
            await _await_send(send, {"type": "text", "token": text, "last": False, "interruptible": True})
            await _await_send(send, {"type": "text", "token": "", "last": True})
            log_assistant_response(text, call_sid=session.call_sid, intent=followup.intent)
            from .conversation_state_machine import record_safe_response, clear_interrupt as clear_state_interrupt
            record_safe_response(session.call_sid, text)
            clear_state_interrupt(session.call_sid)
            CallMemoryManager.update_after_turn(session, caller_text, text, followup.intent)
            logger.info("tool_fanout_skipped reason=followup_context")
            total_ms = (time.monotonic() - t0) * 1000
            logger.info("main_llm_runtime_complete sid=%s total_ms=%.0f source=followup_context", sid, total_ms)
            return RuntimeTurnResult(response_text=text, source="followup_context")

        elif followup.resolved and followup.response_mode == "needs_tools" and followup.tool_categories:
            skip_main_llm = True
            decision = followup_result_to_decision(followup)
            response_mode = decision["response_mode"]
            intent = decision["intent"]
            direct_answer = decision["direct_answer"]
            tool_categories = decision["tool_categories"]
            expected_next = decision.get("expected_next") or ""

        decision: dict = {}
        if not skip_main_llm:
            from ..cart.session import get_ledger
            from .cart_orchestrator import cart_count

            ledger = get_ledger(session)
            commerce_cart = cart_count(commerce)
            cart_summary = (
                f"{commerce_cart} confirmed book(s)" if commerce_cart
                else (f"{ledger.confirmed_count()} confirmed book(s)" if ledger.confirmed_count() else "")
            )

            email_state = "confirmed" if getattr(session, "confirmed_email", "") else (
                "pending" if getattr(session, "pending_email", "") else "none"
            )
            order_state = getattr(session, "last_order_number", "") or ""

            assistants = getattr(getattr(session, "call_memory", None), "assistant_turns", []) or []
            last_assistant = assistants[-1] if assistants else ""

            decision = await main_llm_agent_decide(
                user_turn=turn_text,
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
            expected_next = decision.get("expected_next") or ""
        else:
            decision = {
                "response_mode": response_mode,
                "intent": intent,
                "confidence": 0.95,
                "direct_answer": direct_answer,
                "tool_categories": list(tool_categories),
                "tool_reason": "commerce_commit_or_followup",
                "one_question_to_ask": "",
                "domain_boundary": "in_domain",
                "safety_flags": [],
                "memory_instruction": "",
                "expected_next": expected_next,
                "search_query": "",
                "tool_entities": {},
            }
        if expected_next and hasattr(session, "dialogue"):
            session.dialogue.expected_next = expected_next
        if expected_next:
            commerce.expected_next = expected_next
            save_commerce_session(commerce)

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
            from .intent_result_builder import _build_intent_result_from_agent_decision
            from .pending_tool_state import (
                complete_pending_tool,
                fail_pending_tool,
                start_pending_tool,
            )
            from .tool_answer_composer import compose_answer_from_tool_facts

            router_result = _build_intent_result_from_agent_decision(
                decision, caller_text, session=session, memory_packet=memory,
            )
            pending = start_pending_tool(
                session.call_sid,
                intent=intent,
                categories=tool_categories,
                entities=dict(router_result.entities),
            )

            worker_bundle = await self._execute_main_llm_tools(
                tool_categories, router_result, session, settings,
                decision=decision,
            )
            fact_packet = build_fact_packet(worker_bundle, session)
            facts_n = len(fact_packet.customer_facing_facts)
            logger.info(
                "fact_packet_built sid=%s facts=%d source=tools",
                sid, facts_n,
            )

            from .commerce_session import get_commerce_session, update_candidates_from_facts, sync_commerce_to_session_state
            from .product_fact_normalizer import normalize_product_candidates

            commerce = get_commerce_session(session.call_sid)
            worker_facts = {
                name: (result.data or {})
                for name, result in worker_bundle.results.items()
                if getattr(result, "success", False) and result.data
            }
            if worker_facts:
                candidates = normalize_product_candidates(
                    worker_facts, caller_text, session.call_sid,
                )
                if candidates:
                    update_candidates_from_facts(commerce, candidates)
                    sync_commerce_to_session_state(commerce, session)

            response_text = compose_answer_from_tool_facts(
                intent, fact_packet, worker_bundle, session=session,
            )

            if response_text:
                commerce.last_tool_answer = response_text
                if intent in (
                    "isbn_lookup", "book_title_search", "book_search", "product_search",
                ):
                    commerce.last_product_answer = response_text

            if not response_text:
                from ..composer.main_llm_composer import get_composer
                composer = get_composer(settings)
                system_prompt = load_eric_system_prompt_text()
                logger.info("final_llm_from_tools sid=%s", sid)
                response_text = await self._compose_main_llm_answer(
                    session, caller_text, decision, memory,
                    fact_packet, worker_bundle, system_prompt, composer,
                )

            worker_failures = sum(
                1 for r in worker_bundle.results.values()
                if not getattr(r, "success", False)
            )
            if worker_failures and not response_text:
                from .pending_tool_state import _GRACEFUL_WORKER_FAILURE
                response_text = _GRACEFUL_WORKER_FAILURE
                fail_pending_tool(session.call_sid, reason="worker_failures")
            elif response_text:
                complete_pending_tool(
                    session.call_sid,
                    facts_summary=f"{facts_n} facts",
                    last_tool_answer=response_text,
                )
            else:
                fail_pending_tool(session.call_sid, reason="no_answer")

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
        decision: dict | None = None,
        decision_intent: str = "",
    ):
        """Execute requested tool categories: read-only in parallel, mutating sequential."""
        from ..workers.base import WorkerBundle, WorkerResult
        from ..workers.orchestrator import _REGISTRY, _run_one
        from .tool_category_mapper import (
            MUTATING_CATEGORIES,
            READ_ONLY_CATEGORIES,
            map_tool_categories_to_worker_intents,
        )

        decision = dict(decision or {})
        if tool_categories and not decision.get("tool_categories"):
            decision["tool_categories"] = list(tool_categories)
        if decision_intent and not decision.get("intent"):
            decision["intent"] = decision_intent
        decision_intent = str(decision.get("intent") or router_result.intent)
        sid = session.call_sid[:6]
        timeout_secs = settings.VOICE_TOOL_TIMEOUT_MS / 1000
        t0 = time.monotonic()
        bundle = WorkerBundle()

        plans = map_tool_categories_to_worker_intents(decision, router_result.entities)
        worker_intents = [p.worker_intent for p in plans]
        logger.info(
            "tool_plan_built sid=%s categories=%s worker_intents=%s entities=%s",
            sid, tool_categories, worker_intents, sorted(router_result.entities.keys()),
        )

        primary_intent = worker_intents[0] if worker_intents else decision_intent
        router_result.intent = primary_intent
        router_result.entities["intent"] = primary_intent

        read_only_workers: list[str] = []
        mutating_workers: list[str] = []
        for plan in plans:
            names = [n for n in plan.worker_names if n in _REGISTRY]
            if plan.category in MUTATING_CATEGORIES or plan.mutating:
                mutating_workers.extend(names)
            else:
                read_only_workers.extend(names)

        read_only_workers = list(dict.fromkeys(read_only_workers))
        mutating_workers = list(dict.fromkeys(mutating_workers))
        all_worker_names = list(dict.fromkeys(read_only_workers + mutating_workers))
        bundle.workers_ran = all_worker_names

        logger.info(
            "tool_fanout_started sid=%s read_only=%s mutating=%s",
            sid, read_only_workers, mutating_workers,
        )

        if not all_worker_names:
            bundle.total_ms = 0.0
            logger.info("tool_fanout_completed sid=%s ok=True facts=0 ms=0", sid)
            return bundle

        async def _run_worker(name: str) -> WorkerResult:
            w_t0 = time.monotonic()
            logger.info("tool_worker_started sid=%s worker=%s intent=%s", sid, name, primary_intent)
            try:
                result = await _run_one(
                    name, session, router_result.entities, settings, timeout_secs,
                )
                ms = (time.monotonic() - w_t0) * 1000
                facts_n = 1 if getattr(result, "safe_summary", "") else 0
                if getattr(result, "success", False):
                    logger.info(
                        "tool_worker_completed sid=%s worker=%s ok=True facts=%d ms=%.0f",
                        sid, name, facts_n, ms,
                    )
                else:
                    logger.info(
                        "tool_worker_failed sid=%s worker=%s error_type=%s ms=%.0f",
                        sid, name, getattr(result, "error_code", "failed"), ms,
                    )
                return result
            except Exception as exc:
                ms = (time.monotonic() - w_t0) * 1000
                logger.info(
                    "tool_worker_failed sid=%s worker=%s error_type=%s ms=%.0f",
                    sid, name, type(exc).__name__, ms,
                )
                return WorkerResult(
                    worker_name=name,
                    success=False,
                    error_code=type(exc).__name__,
                    latency_ms=ms,
                    source="none",
                )

        if read_only_workers:
            ro_tasks = {n: asyncio.create_task(_run_worker(n), name=f"worker-{n}") for n in read_only_workers}
            ro_results = await asyncio.gather(*ro_tasks.values(), return_exceptions=True)
            for name, result in zip(ro_tasks.keys(), ro_results):
                if isinstance(result, WorkerResult):
                    bundle.results[name] = result
                else:
                    bundle.results[name] = WorkerResult(
                        worker_name=name,
                        success=False,
                        error_code=type(result).__name__ if isinstance(result, Exception) else "orchestrator_error",
                        latency_ms=(time.monotonic() - t0) * 1000,
                        source="none",
                    )

        for name in mutating_workers:
            if name not in bundle.results:
                result = await _run_worker(name)
                bundle.results[name] = result

        bundle.total_ms = (time.monotonic() - t0) * 1000
        facts_n = sum(1 for r in bundle.results.values() if getattr(r, "success", False))
        logger.info(
            "tool_fanout_completed sid=%s ok=True facts=%d ms=%.0f",
            sid, facts_n, bundle.total_ms,
        )
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
