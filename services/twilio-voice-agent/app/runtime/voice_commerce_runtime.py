"""
Voice Commerce Runtime — single live turn handler for SureShot Books.

Flow:
  Twilio/ConversationRelay → Turn Assembler → Fast Classifier → Main LLM Brain
  → Tool Router → Safety Gates → Final Response → Voice
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional, TYPE_CHECKING

from ..agent_runtime.commerce_flow_state import (
    COMMERCE_FLOW_VERSION,
    advance_commerce_state_silent,
    enforce_commerce_response,
    process_commerce_turn,
)
from ..agent_runtime.payment_flow_state import enforce_payment_response, process_payment_turn
from ..agent_runtime.types import RuntimeTurnResult
from ..agents.main_commerce_brain import MainCommerceBrain
from ..cart.commerce_cart_service import CommerceCartService
from ..payment.email_state import PAYMENT_AUTO_SEND_ENABLED
from ..payment.payment_state_machine import needs_deferred_payment_auto_send
from .fast_classifier import ClassificationResult, classify, normalize_speech_text

if TYPE_CHECKING:
    from ..state.models import SafeCallerContext, SessionState

logger = logging.getLogger(__name__)

RUNTIME_MODE = "voice_commerce_runtime"

_OPENAI_FALLBACK = (
    "I'm having a little trouble with that. "
    "Could you say that again — are you looking to buy something, check an order, or cancel an order?"
)

_STUCK_RECOVERY = (
    "Sorry, I didn't quite get that. "
    "Tell me what you need — buying a book, order status, cancellation, or something else?"
)

_GUIDED_AWAITING_ORDER_PROMPT = "Please tell me your order number."

from ..agent_runtime.voice_workflows import (
    PRODUCT_CLARIFICATION_REPLY as _PRODUCT_CLARIFICATION_REPLY,
    has_structured_product_search_input,
    isbn_detected as _isbn_detected,
    product_title_detected as _product_title_detected,
)

_runtime: Optional["VoiceCommerceRuntime"] = None


def _explicit_search_query(
    session: "SessionState",
    text: str,
    turn_mode: str = "",
) -> bool:
    return _product_title_detected(session, text, turn_mode)


def _product_search_turn_active(
    session: "SessionState",
    text: str,
    turn_mode: str,
    classification: ClassificationResult,
    active_workflow: str,
) -> bool:
    from ..agent_runtime.workflow_isolation import WORKFLOW_PRODUCT, product_handling_allowed

    if not product_handling_allowed(session, turn_mode, text):
        return False
    if active_workflow == WORKFLOW_PRODUCT:
        return True
    return bool(classification.is_product_search)


def _llm_blocked_for_workflow(
    session: "SessionState",
    text: str,
    turn_mode: str,
    classification: ClassificationResult,
    active_workflow: str,
) -> bool:
    """Product and support workflows are deterministic — never route decisions to the LLM."""
    from ..agent_runtime.workflow_contracts import (
        PRODUCT_SEARCH_WORKFLOW,
        SUPPORT_HANDOFF_WORKFLOW,
    )
    from ..agent_runtime.workflow_isolation import (
        WORKFLOW_PRODUCT,
        WORKFLOW_SUPPORT,
        support_handling_allowed,
    )

    if active_workflow in (WORKFLOW_PRODUCT, PRODUCT_SEARCH_WORKFLOW):
        return True
    if active_workflow in (WORKFLOW_SUPPORT, SUPPORT_HANDOFF_WORKFLOW):
        return True
    if support_handling_allowed(session, turn_mode, text):
        return True
    if _product_search_turn_active(session, text, turn_mode, classification, active_workflow):
        return True
    if classification.is_product_search:
        return True
    return False


def requires_product_clarification_before_brain(
    session: "SessionState",
    text: str,
    turn_mode: str = "",
) -> bool:
    """
    True when speech looks like product lookup but lacks ISBN or explicit title/query.

    Catches bare titles (e.g. ``Game of Thrones``) that bypass the classifier's
    ``is_product_search`` flag yet would invite LLM catalog guessing.
    """
    if has_structured_product_search_input(session, text, turn_mode):
        return False

    from ..agent_runtime.isbn_short_circuit import (
        _catalog_query_is_actionable,
        extract_title_catalog_query,
    )
    from ..agent_runtime.order_flow_state import order_intent_detected
    from ..agent_runtime.workflow_isolation import (
        order_workflow_active,
        payment_workflow_active,
    )
    from ..runtime.fast_classifier import (
        _is_facility_question,
        _is_product_search_request,
        is_vague_product_request,
    )

    if not (text or "").strip():
        return False
    if is_vague_product_request(text):
        return False
    if order_intent_detected(text):
        return False
    if _is_facility_question(text):
        return False
    if payment_workflow_active(session, turn_mode) or order_workflow_active(session, turn_mode):
        return False

    if _is_product_search_request(text):
        return True

    query = extract_title_catalog_query(text)
    return _catalog_query_is_actionable(query)


async def _await_send(
    send: Callable,
    msg: dict,
    session: Optional["SessionState"] = None,
) -> None:
    if msg.get("type") == "text" and session is not None:
        if getattr(session, "voice_interrupted", False):
            from ..voice.voice_response_formatter import note_emotion_interrupt

            note_emotion_interrupt(session)
            session.is_speaking = False
            return
        if msg.get("token"):
            session.is_speaking = True
    out = send(msg)
    if asyncio.iscoroutine(out):
        await out
    if msg.get("type") == "text" and session is not None and bool(msg.get("last")):
        if not getattr(session, "voice_interrupted", False):
            session.is_speaking = False


def _result(answer: str, source: str = RUNTIME_MODE, *, end_call: bool = False) -> RuntimeTurnResult:
    return RuntimeTurnResult(response_text=answer, source=source, end_call=end_call)


@dataclass
class OrchestratorPlan:
    """Central turn decision — LLM is fallback, not the default brain."""

    use_llm: bool = False
    reason: str = ""
    stage: str = "idle"
    fast_route: str = ""
    plan_ms: float = 0.0
    classification: Optional[ClassificationResult] = None


class StreamingResponseBuffer:
    """
    Semantic-aware streaming buffer for natural speech rhythm.

    Emits at sentence boundaries (preferred), clause pauses (secondary), or a
    15–18 word safe fallback — never splitting protected entities (orders,
    prices, names, emails).
    """

    _FALLBACK_MIN_WORDS = 15
    _FALLBACK_MAX_WORDS = 18

    _SENTENCE_BREAK = re.compile(r"(?<=[.!?])(?:\s+|$)")
    _CLAUSE_COMMA = re.compile(r",(?:\s+|$)")
    _CLAUSE_CONJUNCTION = re.compile(
        r"\s+(?:and|but|or|so|yet|because|although|though|while|when|if)\s+",
        re.I,
    )
    _ENTITY_PATTERNS: tuple[re.Pattern[str], ...] = (
        re.compile(r"(?:order\s+#?|#)\d{4,}\b", re.I),
        re.compile(r"\$[\d,]+(?:\.\d{2})?"),
        re.compile(r"\b\d{1,4}\s+dollars?\s+and\s+\d{1,2}\s+cents\b", re.I),
        re.compile(r"[\w.+-]+@[\w.-]+\.\w+"),
        re.compile(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b"),
    )

    def __init__(self) -> None:
        self._raw = ""
        self._cursor = 0

    def feed(self, token: str) -> None:
        if token:
            self._raw += token

    @property
    def pending(self) -> str:
        return self._raw[self._cursor:]

    def drain_ready(self) -> list[str]:
        chunks: list[str] = []
        while True:
            boundary = self._next_emit_boundary(self.pending, force=False)
            if boundary is None:
                break
            chunk = self.pending[:boundary].strip()
            self._advance(boundary)
            if chunk:
                chunks.append(chunk)
        return chunks

    def flush(self) -> list[str]:
        remaining = self.pending.strip()
        if not remaining:
            return []
        self._cursor = len(self._raw)
        return self._split_semantic(remaining, force_all=True)

    def _advance(self, boundary: int) -> None:
        end = self._cursor + boundary
        while end < len(self._raw) and self._raw[end] == " ":
            end += 1
        self._cursor = end

    @classmethod
    def _entity_spans(cls, text: str) -> list[tuple[int, int]]:
        spans: list[tuple[int, int]] = []
        for pattern in cls._ENTITY_PATTERNS:
            for match in pattern.finditer(text):
                spans.append((match.start(), match.end()))
        if not spans:
            return []
        spans.sort()
        merged: list[tuple[int, int]] = [spans[0]]
        for start, end in spans[1:]:
            last_start, last_end = merged[-1]
            if start <= last_end:
                merged[-1] = (last_start, max(last_end, end))
            else:
                merged.append((start, end))
        return merged

    @classmethod
    def _split_inside_entity(cls, text: str, index: int) -> bool:
        for start, end in cls._entity_spans(text):
            if start < index < end:
                return True
        return False

    @classmethod
    def _word_count(cls, text: str) -> int:
        return len(text.split())

    @classmethod
    def _word_end_offsets(cls, text: str) -> list[int]:
        ends: list[int] = []
        for match in re.finditer(r"\S+", text):
            ends.append(match.end())
        return ends

    @classmethod
    def _safe_fallback_boundary(cls, pending: str) -> int | None:
        """Force split at 15–18 words without breaking protected entities."""
        word_ends = cls._word_end_offsets(pending)
        if len(word_ends) < cls._FALLBACK_MAX_WORDS:
            return None

        preferred = word_ends[cls._FALLBACK_MAX_WORDS - 1]
        min_idx = word_ends[cls._FALLBACK_MIN_WORDS - 1] if len(word_ends) >= cls._FALLBACK_MIN_WORDS else 0

        for offset in reversed(word_ends):
            if offset < min_idx:
                break
            if offset > preferred:
                continue
            if not cls._split_inside_entity(pending, offset):
                return offset
        return None

    @classmethod
    def _next_emit_boundary(cls, pending: str, *, force: bool) -> int | None:
        if not pending.strip():
            return None

        stripped = pending.lstrip()
        lead = len(pending) - len(stripped)
        candidates: list[int] = []

        for match in cls._SENTENCE_BREAK.finditer(stripped):
            end = lead + match.start()
            while end < len(pending) and pending[end] in " \t":
                end += 1
            candidates.append(end)

        rstrip = pending.rstrip()
        if rstrip and rstrip[-1] in ".!?":
            candidates.append(len(rstrip))

        for match in cls._CLAUSE_COMMA.finditer(stripped):
            end = lead + match.end()
            if not cls._split_inside_entity(pending, end):
                candidates.append(end)

        for match in cls._CLAUSE_CONJUNCTION.finditer(stripped):
            end = lead + match.start()
            if end > lead and not cls._split_inside_entity(pending, end):
                candidates.append(end)

        fallback = cls._safe_fallback_boundary(pending)
        if fallback is not None:
            candidates.append(fallback)

        if force:
            candidates.append(len(pending))

        valid = [
            end for end in candidates
            if end > 0 and cls._word_count(pending[:end]) >= 1
        ]
        if not valid:
            return None
        return min(valid)

    @classmethod
    def _split_semantic(cls, text: str, *, force_all: bool = False) -> list[str]:
        chunks: list[str] = []
        remaining = text
        while remaining.strip():
            boundary = cls._next_emit_boundary(remaining, force=force_all)
            if boundary is None:
                tail = remaining.strip()
                if tail:
                    chunks.append(tail)
                break
            chunk = remaining[:boundary].strip()
            remaining = remaining[boundary:].lstrip()
            if chunk:
                chunks.append(chunk)
        return chunks


class VoiceOrchestrator:
    """
    Voice OS control plane inside voice_commerce_runtime.

    Intent routing, state-machine gates, and LLM gate — no duplicate workflows.
    """

    def plan_turn(
        self,
        runtime: "VoiceCommerceRuntime",
        session: "SessionState",
        caller_text: str,
        turn_mode: str,
        *,
        twiml_greeting: bool = False,
    ) -> OrchestratorPlan:
        t0 = time.monotonic()
        conv = runtime._voice_conversation(session)
        prior_stage = conv.get("stage", "idle") or "idle"
        runtime._sync_voice_conversation_state(session, caller_text, turn_mode=turn_mode)
        conv = runtime._voice_conversation(session)
        stage = conv.get("stage", "idle") or "idle"
        plan = OrchestratorPlan(stage=stage)

        from ..agent_runtime.order_flow_state import (
            extract_order_number,
            is_actionable_order_number,
            order_intent_detected,
        )
        from ..agent_runtime.workflow_isolation import (
            commerce_handling_allowed,
            order_context_on_call,
            order_handling_allowed,
        )
        from ..agent_runtime.yes_engagement import is_bare_yes

        if stage == "awaiting_order_number" and prior_stage == "awaiting_order_number":
            order_num = extract_order_number(caller_text, session, turn_mode=turn_mode)
            if not (order_num and is_actionable_order_number(order_num)):
                plan.use_llm = False
                plan.fast_route = "guided_awaiting"
                plan.reason = "stage_awaiting_order_number"
                plan.plan_ms = (time.monotonic() - t0) * 1000
                return plan

        if stage == "completed":
            plan.use_llm = False
            plan.fast_route = "guided_completed"
            plan.reason = "stage_completed"
            plan.plan_ms = (time.monotonic() - t0) * 1000
            return plan

        if is_bare_yes(caller_text) and (
            commerce_handling_allowed(session, turn_mode, caller_text)
            or order_context_on_call(session)
        ):
            plan.use_llm = False
            plan.fast_route = "yes_engagement"
            plan.reason = "bare_yes_confirmation"
            plan.plan_ms = (time.monotonic() - t0) * 1000
            return plan

        classification = classify(
            caller_text,
            session,
            turn_mode=turn_mode,
            twiml_greeting_already=twiml_greeting,
        )
        plan.classification = classification

        from ..agent_runtime.workflow_isolation import support_handling_allowed

        if support_handling_allowed(session, turn_mode, caller_text):
            plan.use_llm = False
            plan.fast_route = "support_handoff_workflow"
            plan.reason = "support_handoff_deterministic"
            plan.plan_ms = (time.monotonic() - t0) * 1000
            return plan

        if classification.is_product_search:
            plan.use_llm = False
            plan.fast_route = "product_search_workflow"
            plan.reason = "product_search_deterministic"
            plan.plan_ms = (time.monotonic() - t0) * 1000
            return plan

        if classification.action == "instant" and classification.instant_reply:
            plan.use_llm = False
            plan.fast_route = "classifier_instant"
            plan.reason = classification.reason or "classifier_instant"
            plan.plan_ms = (time.monotonic() - t0) * 1000
            return plan

        if classification.skip_llm:
            plan.use_llm = False
            plan.fast_route = "classifier_skip"
            plan.reason = classification.reason or "classifier_skip_llm"
            plan.plan_ms = (time.monotonic() - t0) * 1000
            return plan

        if requires_product_clarification_before_brain(session, caller_text, turn_mode):
            plan.use_llm = False
            plan.fast_route = "product_clarification"
            plan.reason = "product_search_no_structured_input"
            plan.plan_ms = (time.monotonic() - t0) * 1000
            return plan

        if (
            order_handling_allowed(session, turn_mode, caller_text)
            and order_intent_detected(caller_text)
            and not extract_order_number(caller_text, session, turn_mode=turn_mode)
        ):
            plan.use_llm = False
            plan.fast_route = "order_collection"
            plan.reason = "order_intent_no_number"
            plan.plan_ms = (time.monotonic() - t0) * 1000
            return plan

        if classification.action == "ack_then_brain":
            plan.use_llm = True
            plan.fast_route = "ack_then_brain"
            plan.reason = classification.reason or "ack_then_brain"
            plan.plan_ms = (time.monotonic() - t0) * 1000
            return plan

        if classification.action == "brain":
            plan.use_llm = True
            plan.fast_route = "llm_fallback"
            plan.reason = "llm_fallback"
        else:
            plan.use_llm = False
            plan.fast_route = "deterministic"
            plan.reason = classification.reason or "deterministic_route"

        plan.plan_ms = (time.monotonic() - t0) * 1000
        return plan

    @staticmethod
    def allows_llm(plan: OrchestratorPlan) -> bool:
        """LLM is fallback only — never run when plan forbids it."""
        if plan.classification and plan.classification.skip_llm:
            return False
        return plan.use_llm


class VoiceCommerceRuntime:
    """Single-brain commerce runtime for live ConversationRelay turns."""

    def __init__(self, settings=None):
        from ..config import get_settings

        self._settings = settings or get_settings()
        self._brain = MainCommerceBrain(self._settings)
        self._orchestrator = VoiceOrchestrator()

    @staticmethod
    def _voice_conversation(session: "SessionState") -> dict:
        conv = getattr(session, "voice_conversation", None)
        if not isinstance(conv, dict):
            conv = {"stage": "idle", "last_intent": "", "last_order_id": None}
            session.voice_conversation = conv
        return conv

    def _sync_voice_conversation_state(
        self,
        session: "SessionState",
        caller_text: str,
        *,
        turn_mode: str = "",
    ) -> None:
        """Track guided order conversation stage on the live session."""
        from ..agent_runtime.order_flow_state import (
            extract_order_number,
            is_actionable_order_number,
            order_intent_detected,
        )

        conv = self._voice_conversation(session)
        text = (caller_text or "").strip()
        if not text:
            return

        order_num = extract_order_number(text, session, turn_mode=turn_mode)
        has_num = bool(order_num and is_actionable_order_number(order_num))

        if order_intent_detected(text):
            conv["last_intent"] = "order_lookup"
            if not has_num and not (getattr(session, "order_last_voice_reply", "") or "").strip():
                conv["stage"] = "awaiting_order_number"

        if has_num:
            conv["last_order_id"] = order_num.lstrip("#")
            if conv.get("stage") in ("idle", "awaiting_order_number"):
                conv["stage"] = "order_lookup"

    @staticmethod
    def _mark_voice_conversation_completed(session: "SessionState") -> None:
        conv = VoiceCommerceRuntime._voice_conversation(session)
        conv["stage"] = "completed"
        if not conv.get("last_order_id"):
            last = (getattr(session, "last_order_number", "") or "").strip().lstrip("#")
            if last:
                conv["last_order_id"] = last

    def _enforce_awaiting_order_ux(
        self,
        session: "SessionState",
        caller_text: str,
        *,
        turn_mode: str = "",
    ) -> Optional[str]:
        """When collecting an order number, only allow the guided prompt."""
        from ..agent_runtime.order_flow_state import (
            extract_order_number,
            is_actionable_order_number,
        )

        conv = self._voice_conversation(session)
        if conv.get("stage") != "awaiting_order_number":
            return None

        order_num = extract_order_number(caller_text, session, turn_mode=turn_mode)
        if order_num and is_actionable_order_number(order_num):
            conv["stage"] = "order_lookup"
            conv["last_order_id"] = order_num.lstrip("#")
            return None
        return _GUIDED_AWAITING_ORDER_PROMPT

    async def _try_guided_completed_turn(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
    ) -> Optional[RuntimeTurnResult]:
        """After order lookup, replay summary only — no open-ended chat."""
        from ..agent_runtime.order_flow_state import (
            extract_order_number,
            is_actionable_order_number,
            order_intent_detected,
            try_order_followup_reply,
        )

        conv = self._voice_conversation(session)
        if conv.get("stage") != "completed":
            return None

        summary = (getattr(session, "order_last_voice_reply", "") or "").strip()
        if not summary:
            conv["stage"] = "idle"
            return None

        order_num = extract_order_number(caller_text, session, turn_mode=turn_mode)
        if order_num and is_actionable_order_number(order_num):
            conv["stage"] = "order_lookup"
            conv["last_order_id"] = order_num.lstrip("#")
            return None

        if order_intent_detected(caller_text) and not order_num:
            conv["stage"] = "awaiting_order_number"
            conv["last_intent"] = "order_lookup"
            spoken = await self._speak(
                session, caller_text, _GUIDED_AWAITING_ORDER_PROMPT, send,
            )
            return _result(spoken)

        followup = try_order_followup_reply(session, caller_text)
        if followup:
            spoken = self._brain.finalize_response(session, followup, [])
            spoken = await self._speak(
                session, caller_text, spoken, send, interruptible=False,
            )
            return _result(spoken)

        spoken = await self._speak(
            session, caller_text, summary, send, interruptible=False,
        )
        return _result(spoken)

    def _build_live_context(
        self,
        session: "SessionState",
        caller_text: str,
        *,
        turn_mode: str = "",
        caller_context: Optional["SafeCallerContext"] = None,
    ) -> str:
        """LLM context is sandboxed in MainCommerceBrain — no workflow state injection."""
        return ""

    async def _route_product_search_workflow(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
        classification: ClassificationResult,
        sid: str,
    ) -> Optional[RuntimeTurnResult]:
        """Single entry point for product_search_workflow."""
        from ..agent_runtime.commerce_flow_state import enforce_commerce_response
        from ..agent_runtime.voice_workflows import execute_product_search_workflow

        try:
            result = await execute_product_search_workflow(
                session,
                caller_text,
                turn_mode=turn_mode,
                classification=classification,
            )
        except Exception as exc:
            logger.warning(
                "product_search_workflow_failed sid=%s err=%s",
                sid,
                type(exc).__name__,
            )
            spoken = self._brain.finalize_response(session, _OPENAI_FALLBACK, [])
            spoken = await self._speak(session, caller_text, spoken, send)
            return _result(spoken)

        if not result or not result.force_reply:
            return None

        spoken = enforce_commerce_response(
            session,
            self._brain.finalize_response(
                session, result.force_reply, result.tool_results or [],
            ),
            result.tool_results or [],
        )
        spoken = await self._speak(session, caller_text, spoken, send)
        logger.info(
            "product_search_workflow sid=%s route=%s isbn=%s",
            sid,
            result.route or "-",
            (result.isbn or "")[:13],
        )
        return _result(spoken)

    async def _handle_escalation_loop_forced(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
        sid: str,
        guard_result,
    ) -> RuntimeTurnResult:
        """Break infinite workflow loops — force support handoff, no retries, no LLM."""
        from ..agent_runtime.workflow_contracts import SUPPORT_HANDOFF_WORKFLOW

        reply = guard_result.forced_reply or ""
        if guard_result.domain == SUPPORT_HANDOFF_WORKFLOW:
            spoken = await self._speak_support_handoff_reply(
                session, caller_text, reply, send,
            )
            logger.info(
                "escalation_loop_terminal sid=%s stage=%s count=%d",
                sid,
                guard_result.stage,
                guard_result.repeat_count,
            )
            return _result(spoken)

        handoff = await self._route_support_handoff_workflow(
            session, caller_text, send, turn_mode=turn_mode, sid=sid,
        )
        if handoff is not None:
            return handoff

        spoken = await self._speak_support_handoff_reply(
            session, caller_text, reply, send,
        )
        logger.info(
            "escalation_loop_forced_handoff sid=%s domain=%s stage=%s count=%d",
            sid,
            guard_result.domain,
            guard_result.stage,
            guard_result.repeat_count,
        )
        return _result(spoken)

    async def _route_support_handoff_workflow(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
        sid: str,
    ) -> Optional[RuntimeTurnResult]:
        """Single entry point for support_handoff_workflow."""
        from ..agent_runtime.voice_workflows import execute_support_handoff_workflow

        esc_hint = await execute_support_handoff_workflow(
            session, caller_text, turn_mode=turn_mode,
        )
        if esc_hint and esc_hint.force_reply:
            spoken = await self._speak_support_handoff_reply(
                session, caller_text, esc_hint.force_reply, send,
            )
            logger.info("support_handoff_workflow sid=%s", sid)
            return _result(spoken)
        return None

    async def _product_clarification_turn(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
    ) -> RuntimeTurnResult:
        spoken = self._brain.finalize_response(session, _PRODUCT_CLARIFICATION_REPLY, [])
        spoken = await self._speak(session, caller_text, spoken, send)
        return _result(spoken)

    async def _handle_email_fsm(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
    ) -> Optional[RuntimeTurnResult]:
        """Payment checkout email — single process_payment_turn pipeline."""
        payment_hint = process_payment_turn(session, caller_text, turn_mode=turn_mode)
        if payment_hint.force_reply:
            from ..email.speller import is_preserved_email_readback
            from ..payment.email_state import get_pending_payment_email

            reply = payment_hint.force_reply
            if is_preserved_email_readback(reply) and get_pending_payment_email(session):
                spoken = await self._speak_email_readback_text(
                    session, caller_text, reply, send,
                )
            else:
                spoken = await self._speak(session, caller_text, reply, send)
            logger.info("payment_email_workflow sid=%s", session.call_sid[:6])
            return _result(spoken)

        if payment_hint.email_confirmed and PAYMENT_AUTO_SEND_ENABLED:
            return await self._auto_send_payment(session, caller_text, send)

        if needs_deferred_payment_auto_send(session) and PAYMENT_AUTO_SEND_ENABLED:
            return await self._auto_send_payment(session, caller_text, send)

        return None

    async def _auto_send_payment(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
    ) -> RuntimeTurnResult:
        from ..agent_runtime import llm_tools
        from ..agent_runtime.payment_flow_state import parse_tool_result
        from ..payment.payment_link_service import PAYMENT_PROGRESS_MESSAGE

        sid = session.call_sid[:6]
        await _await_send(
            send,
            {
                "type": "text",
                "token": self._format_for_tts(PAYMENT_PROGRESS_MESSAGE),
                "last": False,
                "interruptible": True,
            },
            session,
        )
        raw = await llm_tools.dispatch("send_payment_link", {}, session)
        parsed = parse_tool_result(raw)
        spoken = enforce_payment_response(
            session,
            parsed.get("customer_message") or "I sent the payment link to your email. Please check your inbox.",
            [("send_payment_link", parsed)],
        )
        from ..dialogue.call_closure import mark_awaiting_anything_else, offer_anything_else_suffix

        if parsed.get("email_sent"):
            mark_awaiting_anything_else(session)
            if offer_anything_else_suffix().strip() not in spoken:
                spoken = f"{spoken.rstrip('.')}.{offer_anything_else_suffix()}"
        spoken = await self._speak(session, caller_text, spoken, send)
        logger.info("payment_auto_send sid=%s success=%s", sid, bool(parsed.get("email_sent")))
        return _result(spoken)

    @staticmethod
    def _apply_voice_output_pipeline(
        spoken: str,
        session: Optional["SessionState"] = None,
        *,
        user_text: str = "",
    ) -> str:
        """Voice Output Contract → VoiceResponseFormatter. Single TTS prep path."""
        from ..voice.voice_output_contract import enforce_voice_output_contract
        from ..voice.voice_response_formatter import format_voice_response

        contract = enforce_voice_output_contract(spoken)
        return format_voice_response(
            contract.content,
            session,
            user_text=user_text,
        ).speech_text

    @staticmethod
    def _format_for_tts(
        spoken: str,
        session: Optional["SessionState"] = None,
        *,
        user_text: str = "",
    ) -> str:
        """Normalize handler text into short voice-ready speech before Twilio TTS."""
        from ..email.speller import is_preserved_email_readback

        text = (spoken or "").strip()
        if not text or is_preserved_email_readback(text):
            return text
        return VoiceCommerceRuntime._apply_voice_output_pipeline(
            text,
            session,
            user_text=user_text,
        )

    @staticmethod
    def _enforce_llm_voice_contract(raw_llm_text: str) -> str:
        """Force LLM output into voice contract content before guardrails/formatting."""
        from ..voice.voice_output_contract import enforce_voice_output_contract

        contract = enforce_voice_output_contract(raw_llm_text or "")
        return contract.content

    async def _speak_support_handoff_reply(
        self,
        session: "SessionState",
        caller_text: str,
        reply: str,
        send: Callable,
    ) -> str:
        """Support handoff replies always use normal TTS — never email readback chunks."""
        spoken = self._brain.finalize_response(session, reply, [])
        return await self._speak(session, caller_text, spoken, send)

    async def _speak_email_readback_text(
        self,
        session: "SessionState",
        caller_text: str,
        full_text: str,
        send: Callable,
    ) -> str:
        """Deliver letter-by-letter readback in paced chunks for clear TTS."""
        from ..email.speller import build_email_readback_parts
        from ..payment.email_state import get_pending_payment_email

        email = get_pending_payment_email(session) or ""
        pending_esc = getattr(session, "pending_not_found_escalation", None) or {}
        if not email and isinstance(pending_esc, dict):
            email = (pending_esc.get("staging_email") or "").strip().lower()

        parts = build_email_readback_parts(email, caller_text) if email else [full_text]
        session.history.append({"role": "user", "content": caller_text})
        non_empty = [p.strip() for p in parts if p.strip()]
        for part in non_empty:
            await _await_send(
                send,
                {
                    "type": "text",
                    "token": part,
                    "last": True,
                    "play_immediately": True,
                    "interruptible": False,
                },
                session,
            )
        combined = " ".join(non_empty)
        session.history.append({"role": "assistant", "content": combined})
        self._record_turn(session, caller_text, combined)
        return combined

    @staticmethod
    def _format_stream_chunk(
        spoken: str,
        session: Optional["SessionState"] = None,
        *,
        user_text: str = "",
    ) -> str:
        """Voice Contract → Formatter for one streaming micro-chunk."""
        from ..email.speller import is_preserved_email_readback

        text = (spoken or "").strip()
        if not text or is_preserved_email_readback(text):
            return text
        return VoiceCommerceRuntime._apply_voice_output_pipeline(
            text,
            session,
            user_text=user_text,
        )

    async def _emit_stream_speech_chunks(
        self,
        session: "SessionState",
        send: Callable,
        chunks: list[str],
        *,
        user_text: str = "",
        interruptible: bool = True,
    ) -> list[str]:
        """Deliver formatted chunks through play_immediately TTS (interrupt-safe)."""
        emitted: list[str] = []
        for chunk in chunks:
            if getattr(session, "voice_interrupted", False):
                break
            formatted = self._format_stream_chunk(chunk, session, user_text=user_text)
            if not formatted:
                continue
            emitted.append(formatted)
            await _await_send(
                send,
                {
                    "type": "text",
                    "token": formatted,
                    "last": False,
                    "play_immediately": True,
                    "interruptible": interruptible,
                },
                session,
            )
        return emitted

    async def _speak_streaming_llm(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        on_token_source: Callable[[Callable[[str], Awaitable[None]]], Awaitable[tuple[str, list, list]]],
        interruptible: bool = True,
    ) -> tuple[str, list[str], list[tuple[str, dict]], list[str]]:
        """
        Stream LLM tokens into speech chunks: Contract → Formatter → TTS.

        Returns (final_text, tools_used, tool_results, spoken_chunks).
        """
        buffer = StreamingResponseBuffer()
        spoken_parts: list[str] = []

        async def on_token(token: str) -> None:
            if getattr(session, "voice_interrupted", False):
                return
            buffer.feed(token)
            new_chunks = await self._emit_stream_speech_chunks(
                session, send, buffer.drain_ready(),
                user_text=caller_text,
                interruptible=interruptible,
            )
            spoken_parts.extend(new_chunks)

        final_text, tools_used, tool_results = await on_token_source(on_token)

        if spoken_parts and not getattr(session, "voice_interrupted", False):
            tail = await self._emit_stream_speech_chunks(
                session, send, buffer.flush(),
                user_text=caller_text,
                interruptible=interruptible,
            )
            spoken_parts.extend(tail)
            await _await_send(send, {"type": "text", "token": "", "last": True}, session)

        return final_text, tools_used, tool_results, spoken_parts

    async def _speak(
        self,
        session: "SessionState",
        caller_text: str,
        spoken: str,
        send: Callable,
        *,
        interruptible: bool = True,
        skip_user_history: bool = False,
    ) -> str:
        tts_text = self._format_for_tts(spoken, session, user_text=caller_text)
        if getattr(session, "voice_interrupted", False):
            session.is_speaking = False
            return tts_text
        if not skip_user_history:
            session.history.append({"role": "user", "content": caller_text})
        session.history.append({"role": "assistant", "content": tts_text})
        await _await_send(
            send,
            {
                "type": "text",
                "token": tts_text,
                "last": False,
                "interruptible": interruptible,
            },
            session,
        )
        await _await_send(send, {"type": "text", "token": "", "last": True}, session)
        self._record_turn(session, caller_text, tts_text)
        return tts_text

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
    ) -> RuntimeTurnResult:
        sid = (session.call_sid or "")[:6]
        t0 = time.monotonic()
        turn_mode = assembled_turn_mode or getattr(turn, "mode", "") or ""
        normalized = normalize_speech_text(caller_text)

        logger.info(
            "voice_commerce_start sid=%s turn_mode=%s text=%r",
            sid,
            turn_mode or "normal",
            normalized[:60],
        )

        if not getattr(self._settings, "OPENAI_API_KEY", ""):
            spoken = _OPENAI_FALLBACK
            spoken = await self._speak(session, normalized, spoken, send)
            return _result(spoken)

        session._current_turn_mode = turn_mode  # type: ignore[attr-defined]
        session._current_caller_text = normalized  # type: ignore[attr-defined]

        from ..agent_runtime.workflow_contracts import clear_turn_workflow_contract

        clear_turn_workflow_contract(session)

        from ..agent_runtime.workflow_isolation import (
            WORKFLOW_ISOLATION_VERSION,
            commerce_handling_allowed,
            commerce_silent_advance_allowed,
            isolate_workflow_buffers,
            order_handling_allowed,
            payment_handling_allowed,
            product_handling_allowed,
            support_handling_allowed,
        )

        active_workflow = isolate_workflow_buffers(session, turn_mode, normalized)
        from ..agent_runtime.workflow_contracts import apply_turn_workflow_contract

        apply_turn_workflow_contract(session, active_workflow)
        logger.info(
            "workflow_isolation sid=%s workflow=%s version=%s",
            sid,
            active_workflow,
            WORKFLOW_ISOLATION_VERSION,
        )

        from ..agent_runtime.escalation_guard import EscalationGuard
        from ..agent_runtime.workflow_contracts import CANONICAL_WORKFLOW_DOMAINS

        if active_workflow in CANONICAL_WORKFLOW_DOMAINS:
            guard_result = EscalationGuard.check_turn(
                session,
                active_workflow,
                normalized,
                turn_mode=turn_mode,
            )
            if guard_result.loop_detected:
                return await self._handle_escalation_loop_forced(
                    session,
                    normalized,
                    send,
                    turn_mode=turn_mode,
                    sid=sid,
                    guard_result=guard_result,
                )

        if commerce_silent_advance_allowed(session, turn_mode, normalized):
            advance_commerce_state_silent(session, normalized)

        from ..agent_runtime.isbn_short_circuit import resolve_spoken_isbn

        if product_handling_allowed(session, turn_mode, normalized):
            if re.search(
                r"\b(isbn|978|979|ouspl|iuspl|iouspl)\b", normalized, re.I,
            ) or getattr(session, "pending_isbn_buffer", ""):
                resolve_spoken_isbn(normalized, session=session, turn_mode=turn_mode)

        from ..dialogue.call_closure import process_call_closure_turn

        closure = process_call_closure_turn(session, normalized)
        if closure is not None:
            spoken = self._brain.finalize_response(session, closure.reply, [])
            spoken = await self._speak(session, normalized, spoken, send)
            return _result(spoken, end_call=closure.end_call)

        from ..payment.payment_state_machine import payment_email_turn_priority

        if support_handling_allowed(session, turn_mode, normalized):
            handoff = await self._route_support_handoff_workflow(
                session, normalized, send, turn_mode=turn_mode, sid=sid,
            )
            if handoff is not None:
                return handoff

        if payment_handling_allowed(session, turn_mode, normalized) or payment_email_turn_priority(
            session, turn_mode,
        ):
            email_early = await self._handle_email_fsm(
                session, normalized, send, turn_mode=turn_mode,
            )
            if email_early is not None:
                return email_early

        guided_completed = await self._try_guided_completed_turn(
            session, normalized, send, turn_mode=turn_mode,
        )
        if guided_completed is not None:
            logger.info("guided_completed_turn sid=%s", sid)
            return guided_completed

        twiml_greeting = bool(getattr(session, "twiml_greeting_spoken", False))
        plan = self._orchestrator.plan_turn(
            self, session, normalized, turn_mode, twiml_greeting=twiml_greeting,
        )
        logger.info(
            "voice_orchestrator_plan sid=%s use_llm=%s stage=%s route=%s reason=%s ms=%.1f",
            sid,
            plan.use_llm,
            plan.stage,
            plan.fast_route or "-",
            plan.reason,
            plan.plan_ms,
        )
        classification = plan.classification
        if classification is None:
            classification = classify(
                normalized,
                session,
                turn_mode=turn_mode,
                twiml_greeting_already=twiml_greeting,
            )

        if plan.fast_route == "product_clarification":
            spoken = await self._product_clarification_turn(session, normalized, send)
            logger.info("product_clarification_orchestrator sid=%s", sid)
            return spoken

        from ..dialogue.anti_silence import anti_silence_reply
        from ..dialogue.side_speech import side_speech_reply

        side = side_speech_reply(normalized)
        if side:
            spoken = self._brain.finalize_response(session, side, [])
            spoken = await self._speak(session, normalized, spoken, send)
            logger.info("side_speech_short_circuit sid=%s", sid)
            return _result(spoken)

        presence = anti_silence_reply(session, normalized)
        if presence:
            spoken = self._brain.finalize_response(session, presence, [])
            spoken = await self._speak(session, normalized, spoken, send)
            logger.info("anti_silence_short_circuit sid=%s", sid)
            return _result(spoken)

        from ..agent_runtime.workflow_isolation import order_context_on_call
        from ..agent_runtime.order_flow_state import (
            is_order_followup_question,
            try_order_followup_reply,
        )

        if order_context_on_call(session) and is_order_followup_question(normalized):
            followup_early = try_order_followup_reply(session, normalized)
            if followup_early:
                spoken = self._brain.finalize_response(session, followup_early, [])
                spoken = await self._speak(session, normalized, spoken, send, interruptible=False)
                logger.info("order_followup_early sid=%s", sid)
                return _result(spoken)

        from ..agent_runtime.order_flow_state import (
            _should_skip_order_lookup,
            extract_order_number,
            is_actionable_order_number,
            try_another_order_short_circuit,
            try_order_collection_short_circuit,
            try_order_enrichment_short_circuit,
            try_order_followup_reply,
            try_order_hold_reply,
            try_order_repeat_reply,
        )

        if order_handling_allowed(session, turn_mode, normalized):
            awaiting_prompt = self._enforce_awaiting_order_ux(
                session, normalized, turn_mode=turn_mode,
            )
            if awaiting_prompt:
                spoken = await self._speak(session, normalized, awaiting_prompt, send)
                logger.info("guided_awaiting_order_number sid=%s", sid)
                return _result(spoken)

            if not payment_email_turn_priority(session, turn_mode):
                if not _should_skip_order_lookup(normalized, session, turn_mode=turn_mode):
                    spoken_order_num = extract_order_number(
                        normalized, session, turn_mode=turn_mode,
                    )
                    if spoken_order_num and is_actionable_order_number(spoken_order_num):
                        try:
                            order_hint = await try_order_enrichment_short_circuit(
                                session, normalized, turn_mode=turn_mode,
                            )
                        except Exception as exc:
                            logger.warning(
                                "order_enrichment_failed sid=%s err=%s",
                                sid,
                                type(exc).__name__,
                            )
                            order_hint = None
                        if order_hint and order_hint.force_reply:
                            from ..dialogue.call_closure import (
                                mark_awaiting_anything_else,
                                offer_anything_else_suffix,
                            )

                            spoken = self._brain.finalize_response(
                                session, order_hint.force_reply, [],
                            )
                            conv = self._voice_conversation(session)
                            if conv.get("stage") == "order_lookup":
                                self._mark_voice_conversation_completed(session)
                            else:
                                mark_awaiting_anything_else(session)
                                suffix = offer_anything_else_suffix()
                                if suffix.strip() not in spoken:
                                    spoken = f"{spoken.rstrip('.')}.{suffix}"
                            spoken = await self._speak(
                                session, normalized, spoken, send, interruptible=False,
                            )
                            logger.info("order_enrichment_short_circuit sid=%s", sid)
                            return _result(spoken)

            followup_reply = try_order_followup_reply(session, normalized)
            if followup_reply:
                spoken = self._brain.finalize_response(session, followup_reply, [])
                spoken = await self._speak(session, normalized, spoken, send, interruptible=False)
                logger.info("order_followup_short_circuit sid=%s", sid)
                return _result(spoken)

            repeat_reply = try_order_repeat_reply(session, normalized)
            spoken_num = extract_order_number(normalized, session, turn_mode=turn_mode)
            if repeat_reply and not (spoken_num and is_actionable_order_number(spoken_num)):
                spoken = self._brain.finalize_response(session, repeat_reply, [])
                spoken = await self._speak(session, normalized, spoken, send, interruptible=False)
                logger.info("order_repeat_short_circuit sid=%s", sid)
                return _result(spoken)

            hold_reply = try_order_hold_reply(session, normalized)
            if hold_reply:
                spoken = self._brain.finalize_response(session, hold_reply, [])
                spoken = await self._speak(session, normalized, spoken, send, interruptible=False)
                logger.info("order_hold_short_circuit sid=%s", sid)
                return _result(spoken)

            another_hint = try_another_order_short_circuit(
                session, normalized, turn_mode=turn_mode,
            )
            if another_hint and another_hint.force_reply:
                spoken = self._brain.finalize_response(
                    session, another_hint.force_reply, [],
                )
                spoken = await self._speak(session, normalized, spoken, send)
                logger.info("another_order_short_circuit sid=%s", sid)
                return _result(spoken)

            collection_hint = try_order_collection_short_circuit(
                session, normalized, turn_mode=turn_mode,
            )
            if collection_hint and collection_hint.force_reply:
                conv = self._voice_conversation(session)
                reply = (
                    _GUIDED_AWAITING_ORDER_PROMPT
                    if conv.get("stage") == "awaiting_order_number"
                    else collection_hint.force_reply
                )
                spoken = self._brain.finalize_response(session, reply, [])
                spoken = await self._speak(session, normalized, spoken, send)
                logger.info("order_collection_short_circuit sid=%s", sid)
                return _result(spoken)

        email_result = None
        if payment_handling_allowed(session, turn_mode, normalized):
            email_result = await self._handle_email_fsm(
                session, normalized, send, turn_mode=turn_mode,
            )
        if email_result is not None:
            return email_result

        if support_handling_allowed(session, turn_mode, normalized):
            handoff = await self._route_support_handoff_workflow(
                session, normalized, send, turn_mode=turn_mode, sid=sid,
            )
            if handoff is not None:
                return handoff

        if classification.action == "instant" and classification.instant_reply:
            if classification.reason == "isbn_offer_prompt":
                from ..agent_runtime.isbn_short_circuit import arm_isbn_digit_collection

                arm_isbn_digit_collection(session)
            instant_reply = classification.instant_reply
            if classification.reason == "order_collection_prompt":
                self._voice_conversation(session)["stage"] = "awaiting_order_number"
                self._voice_conversation(session)["last_intent"] = "order_lookup"
                instant_reply = _GUIDED_AWAITING_ORDER_PROMPT
            spoken = self._brain.finalize_response(session, instant_reply, [])
            spoken = await self._speak(session, normalized, spoken, send)
            logger.info(
                "fast_classifier_instant sid=%s reason=%s ms=%.0f",
                sid,
                classification.reason,
                (time.monotonic() - t0) * 1000,
            )
            return _result(spoken)

        if classification.is_cancellation_request and not support_handling_allowed(
            session, turn_mode, normalized,
        ):
            from ..agent_runtime.not_found_escalation_flow import (
                try_cancellation_support_handoff,
            )

            cancel_hint = await try_cancellation_support_handoff(
                session, normalized, turn_mode=turn_mode,
            )
            if cancel_hint.force_reply:
                spoken = self._brain.finalize_response(session, cancel_hint.force_reply, [])
                spoken = await self._speak(session, normalized, spoken, send)
                logger.info("cancellation_support_handoff sid=%s", sid)
                return _result(spoken)

        if _product_search_turn_active(
            session, normalized, turn_mode, classification, active_workflow,
        ):
            product_result = await self._route_product_search_workflow(
                session,
                normalized,
                send,
                turn_mode=turn_mode,
                classification=classification,
                sid=sid,
            )
            if product_result is not None:
                return product_result

        from ..agent_runtime.order_flow_state import (
            _should_skip_order_lookup,
            extract_order_number,
            order_intent_detected,
            try_order_enrichment_short_circuit,
        )

        is_order_turn = (
            order_handling_allowed(session, turn_mode, normalized)
            and not _should_skip_order_lookup(normalized, session, turn_mode=turn_mode)
            and (turn_mode or "").lower() not in ("isbn", "email")
            and (
                (turn_mode or "").lower() == "order"
                or bool(extract_order_number(normalized, session, turn_mode=turn_mode))
                or classification.is_order_lookup
                or order_intent_detected(normalized)
            )
        )
        if is_order_turn:
            try:
                order_hint = await try_order_enrichment_short_circuit(
                    session, normalized, turn_mode=turn_mode,
                )
            except Exception as exc:
                logger.warning("order_enrichment_failed sid=%s err=%s", sid, type(exc).__name__)
                order_hint = None
            if order_hint and order_hint.force_reply:
                self._mark_voice_conversation_completed(session)
                spoken = self._brain.finalize_response(session, order_hint.force_reply, [])
                spoken = await self._speak(session, normalized, spoken, send, interruptible=False)
                logger.info("order_enrichment_short_circuit sid=%s", sid)
                return _result(spoken)

            if order_intent_detected(normalized) and not extract_order_number(
                normalized, session, turn_mode=turn_mode,
            ):
                from ..agent_runtime.order_flow_state import try_order_collection_short_circuit

                collection_hint = try_order_collection_short_circuit(
                    session, normalized, turn_mode=turn_mode,
                )
                if collection_hint and collection_hint.force_reply:
                    conv = self._voice_conversation(session)
                    reply = (
                        _GUIDED_AWAITING_ORDER_PROMPT
                        if conv.get("stage") == "awaiting_order_number"
                        else collection_hint.force_reply
                    )
                    spoken = self._brain.finalize_response(
                        session, reply, [],
                    )
                    spoken = await self._speak(session, normalized, spoken, send)
                    logger.info("order_collection_before_brain sid=%s", sid)
                    return _result(spoken)

        from ..agent_runtime.commerce_flow_state import try_cart_inquiry_reply
        from ..tools.isbn import extract_isbn_candidate

        if commerce_handling_allowed(session, turn_mode, normalized):
            if (turn_mode or "").lower() == "isbn" or extract_isbn_candidate(normalized):
                product_in_cart = await self._route_product_search_workflow(
                    session,
                    normalized,
                    send,
                    turn_mode=turn_mode,
                    classification=classification,
                    sid=sid,
                )
                if product_in_cart is not None:
                    return product_in_cart

            cart_reply = try_cart_inquiry_reply(
                session, normalized, turn_mode=turn_mode,
            )
            if cart_reply:
                spoken = self._brain.finalize_response(session, cart_reply, [])
                spoken = await self._speak(session, normalized, spoken, send)
                logger.info("cart_inquiry_short_circuit sid=%s", sid)
                return _result(spoken)

            commerce_hint = process_commerce_turn(
                session, normalized, turn_mode=turn_mode,
            )
            if commerce_hint.force_reply:
                spoken = enforce_commerce_response(
                    session,
                    self._brain.finalize_response(session, commerce_hint.force_reply, []),
                    [],
                )
                spoken = await self._speak(session, normalized, spoken, send)
                logger.info(
                    "commerce_flow_short_circuit sid=%s book_added=%s version=%s",
                    sid,
                    commerce_hint.book_added,
                    COMMERCE_FLOW_VERSION,
                )
                return _result(spoken)

        from ..agent_runtime.yes_engagement import is_bare_yes, yes_engagement_reply
        from ..agent_runtime.workflow_isolation import order_context_on_call

        if is_bare_yes(normalized) and (
            commerce_handling_allowed(session, turn_mode, normalized)
            or order_context_on_call(session)
        ):
            engage = yes_engagement_reply(session) or ""
            spoken = self._brain.finalize_response(session, engage, [])
            spoken = await self._speak(session, normalized, spoken, send)
            logger.info("yes_engagement_short_circuit sid=%s", sid)
            return _result(spoken)

        if classification.action == "ack_then_brain" and classification.ack_reply:
            await _await_send(
                send,
                {
                    "type": "text",
                    "token": self._format_for_tts(classification.ack_reply),
                    "last": False,
                    "interruptible": True,
                },
                session,
            )

        from ..agent_runtime.order_flow_state import try_order_brain_gate

        order_brain_gate = ""
        if order_handling_allowed(session, turn_mode, normalized):
            order_brain_gate = try_order_brain_gate(session, normalized, turn_mode=turn_mode) or ""
        if order_brain_gate:
            spoken = self._brain.finalize_response(session, order_brain_gate, [])
            spoken = await self._speak(session, normalized, spoken, send, interruptible=False)
            logger.info("order_brain_gate sid=%s", sid)
            return _result(spoken)

        if _llm_blocked_for_workflow(
            session, normalized, turn_mode, classification, active_workflow,
        ):
            if support_handling_allowed(session, turn_mode, normalized):
                handoff = await self._route_support_handoff_workflow(
                    session, normalized, send, turn_mode=turn_mode, sid=sid,
                )
                if handoff is not None:
                    return handoff
            if _product_search_turn_active(
                session, normalized, turn_mode, classification, active_workflow,
            ):
                product_result = await self._route_product_search_workflow(
                    session,
                    normalized,
                    send,
                    turn_mode=turn_mode,
                    classification=classification,
                    sid=sid,
                )
                if product_result is not None:
                    return product_result
            logger.info("workflow_llm_gate sid=%s workflow=%s", sid, active_workflow or "-")
            return await self._product_clarification_turn(session, normalized, send)

        if requires_product_clarification_before_brain(session, normalized, turn_mode):
            logger.info("product_clarification_pre_brain sid=%s", sid)
            return await self._product_clarification_turn(session, normalized, send)

        if not VoiceOrchestrator.allows_llm(plan):
            spoken = _STUCK_RECOVERY
            spoken = await self._speak(session, normalized, spoken, send)
            logger.info(
                "voice_orchestrator_llm_skipped sid=%s reason=%s route=%s",
                sid,
                plan.reason,
                plan.fast_route or "-",
            )
            return _result(spoken)

        live_context = self._build_live_context(
            session, normalized, turn_mode=turn_mode, caller_context=caller_context,
        )

        stream_enabled = bool(getattr(self._settings, "VOICE_LLM_STREAM_ENABLED", True))

        async def _run_brain(on_token=None):
            return await self._brain.run_turn(
                session,
                normalized,
                send,
                turn_mode=turn_mode,
                use_strong_model=classification.use_strong_model,
                live_context=live_context,
                caller_context=caller_context,
                on_token=on_token,
            )

        try:
            if stream_enabled:
                final_text, tools_used, tool_results, streamed_parts = (
                    await self._speak_streaming_llm(
                        session,
                        normalized,
                        send,
                        on_token_source=_run_brain,
                    )
                )
            else:
                final_text, tools_used, tool_results = await _run_brain()
                streamed_parts = []
        except Exception as exc:
            logger.error("brain_error sid=%s err=%s", sid, type(exc).__name__)
            spoken = _OPENAI_FALLBACK
            spoken = await self._speak(session, normalized, spoken, send)
            return _result(spoken)

        if not final_text:
            spoken = _STUCK_RECOVERY
            spoken = await self._speak(session, normalized, spoken, send)
            return _result(spoken)

        final_text = self._enforce_llm_voice_contract(final_text)
        final_text = enforce_commerce_response(session, final_text, tool_results)
        from ..agent_runtime.order_parallel_enrichment import enforce_order_response

        final_text = enforce_order_response(session, final_text, tool_results)
        spoken = self._brain.finalize_response(session, final_text, tool_results)

        if streamed_parts:
            session.history.append({"role": "assistant", "content": spoken})
            self._record_turn(session, normalized, spoken)
        else:
            spoken = await self._speak(
                session, normalized, spoken, send, skip_user_history=True,
            )

        logger.info(
            "voice_commerce_complete sid=%s tools=%s chars=%d ms=%.0f reason=%s",
            sid,
            ",".join(tools_used) or "none",
            len(spoken),
            (time.monotonic() - t0) * 1000,
            classification.reason,
        )
        from ..dialogue.call_closure import caller_wants_to_end, process_call_closure_turn

        if caller_wants_to_end(normalized):
            closure = process_call_closure_turn(session, normalized)
            if closure and closure.end_call:
                return _result(closure.reply, end_call=True)
        return _result(spoken)

    @staticmethod
    def _record_turn(session: "SessionState", user_text: str, assistant_text: str) -> None:
        try:
            from ..conversation.call_memory import record_turn_pair

            record_turn_pair(session, user_text, assistant_text)
        except Exception:  # noqa: BLE001
            pass


def get_voice_commerce_runtime(settings=None) -> VoiceCommerceRuntime:
    global _runtime
    if _runtime is None or settings is not None:
        _runtime = VoiceCommerceRuntime(settings)
    return _runtime


def voice_commerce_enabled(settings=None) -> bool:
    from ..config import get_settings

    s = settings or get_settings()
    return bool(getattr(s, "VOICE_COMMERCE_RUNTIME_ENABLED", True))
