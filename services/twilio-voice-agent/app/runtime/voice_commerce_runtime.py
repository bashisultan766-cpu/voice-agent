"""
Voice Commerce Runtime — single live turn handler for SureShot Books.

Flow:
  Twilio/ConversationRelay → Turn Assembler → Fast Classifier → Main LLM Brain
  → Tool Router → Safety Gates → Final Response → Voice
"""
from __future__ import annotations

import asyncio
import logging
import time
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
from ..email.voice_email_capture import VoiceEmailCapture
from ..payment.email_state import PAYMENT_AUTO_SEND_ENABLED
from ..payment.payment_state_machine import needs_deferred_payment_auto_send
from .fast_classifier import ClassificationResult, classify, normalize_speech_text

if TYPE_CHECKING:
    from ..state.models import SafeCallerContext, SessionState

logger = logging.getLogger(__name__)

RUNTIME_MODE = "voice_commerce_runtime"

_OPENAI_FALLBACK = (
    "I'm having trouble checking that right now. "
    "Could you say the title or ISBN again?"
)

_runtime: Optional["VoiceCommerceRuntime"] = None


async def _await_send(send: Callable, msg: dict) -> None:
    out = send(msg)
    if asyncio.iscoroutine(out):
        await out


def _result(answer: str, source: str = RUNTIME_MODE, *, end_call: bool = False) -> RuntimeTurnResult:
    return RuntimeTurnResult(response_text=answer, source=source, end_call=end_call)


class VoiceCommerceRuntime:
    """Single-brain commerce runtime for live ConversationRelay turns."""

    def __init__(self, settings=None):
        from ..config import get_settings

        self._settings = settings or get_settings()
        self._brain = MainCommerceBrain(self._settings)

    def _build_live_context(
        self,
        session: "SessionState",
        caller_text: str,
        *,
        turn_mode: str = "",
        caller_context: Optional["SafeCallerContext"] = None,
    ) -> str:
        base = self._brain._build_live_context(session, caller_text, turn_mode=turn_mode)
        try:
            from ..agent_runtime.isbn_short_circuit import (
                isbn_context_for_state_block,
                prepare_isbn_turn_context,
            )

            prepare_isbn_turn_context(session, caller_text, turn_mode=turn_mode)
            isbn_hint = isbn_context_for_state_block(session, caller_text, turn_mode=turn_mode)
            if isbn_hint:
                return f"{base}\n{isbn_hint}"
        except Exception:  # noqa: BLE001
            pass
        return base

    async def _try_isbn_product_hunt(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
        classification: ClassificationResult,
    ) -> Optional[RuntimeTurnResult]:
        """Run deterministic ISBN resolution + Shopify search without LLM latency."""
        from ..agent_runtime.isbn_short_circuit import (
            _looks_like_isbn_digit_stream,
            arm_isbn_digit_collection,
            conversational_ack_reply,
            is_conversational_ack,
            try_isbn_short_circuit,
        )
        from ..tools.isbn import extract_isbn_candidate

        if is_conversational_ack(caller_text):
            ack = conversational_ack_reply(session, turn_mode=turn_mode)
            if ack:
                spoken = self._brain.finalize_response(session, ack, [])
                await self._speak(session, caller_text, spoken, send)
                return _result(spoken)

        is_isbn_turn = (
            (turn_mode or "").lower() == "isbn"
            or classification.is_product_search
            or bool(extract_isbn_candidate(caller_text))
            or _looks_like_isbn_digit_stream(caller_text)
            or bool(getattr(session, "pending_isbn_buffer", ""))
        )
        if not is_isbn_turn:
            return None

        sid = (session.call_sid or "")[:6]
        try:
            sc = await try_isbn_short_circuit(session, caller_text, turn_mode=turn_mode)
        except Exception as exc:
            logger.warning("isbn_product_hunt_failed sid=%s err=%s", sid, type(exc).__name__)
            spoken = self._brain.finalize_response(session, _OPENAI_FALLBACK, [])
            await self._speak(session, caller_text, spoken, send)
            return _result(spoken)

        if not sc or not sc.force_reply:
            return None

        spoken = enforce_commerce_response(
            session,
            self._brain.finalize_response(session, sc.force_reply, sc.tool_results or []),
            sc.tool_results or [],
        )
        await self._speak(session, caller_text, spoken, send)
        logger.info(
            "isbn_product_hunt sid=%s isbn=%s ms=fast",
            sid,
            sc.isbn or "",
        )
        return _result(spoken)

    async def _handle_email_fsm(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
    ) -> Optional[RuntimeTurnResult]:
        """Deterministic email capture and confirmation — no LLM."""
        email_cap = VoiceEmailCapture(session)

        if getattr(session, "awaiting_payment_email_confirmation", False):
            result = email_cap.process_confirmation_turn(caller_text)
            if result.action == "confirmed":
                if PAYMENT_AUTO_SEND_ENABLED:
                    return None
                spoken = "Got it. I'll send the payment link to your email."
                await self._speak(session, caller_text, spoken, send)
                return _result(spoken)
            if result.readback:
                await self._speak(session, caller_text, result.readback, send)
                return _result(result.readback)

        payment_hint = process_payment_turn(session, caller_text, turn_mode=turn_mode)
        if payment_hint.force_reply:
            spoken = payment_hint.force_reply
            await self._speak(session, caller_text, spoken, send)
            logger.info("email_fsm_force_reply sid=%s", session.call_sid[:6])
            return _result(spoken)

        if payment_hint.email_confirmed and PAYMENT_AUTO_SEND_ENABLED:
            return await self._auto_send_payment(session, caller_text, send)

        if needs_deferred_payment_auto_send(session) and PAYMENT_AUTO_SEND_ENABLED:
            return await self._auto_send_payment(session, caller_text, send)

        if (turn_mode or "").lower() == "email" or getattr(session, "awaiting_payment_email", False):
            captured = email_cap.capture_from_speech(caller_text)
            if captured.readback:
                await self._speak(session, caller_text, captured.readback, send)
                return _result(captured.readback)

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
            {"type": "text", "token": PAYMENT_PROGRESS_MESSAGE, "last": False, "interruptible": True},
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
        await self._speak(session, caller_text, spoken, send)
        logger.info("payment_auto_send sid=%s success=%s", sid, bool(parsed.get("email_sent")))
        return _result(spoken)

    async def _speak(
        self,
        session: "SessionState",
        caller_text: str,
        spoken: str,
        send: Callable,
    ) -> None:
        session.history.append({"role": "user", "content": caller_text})
        session.history.append({"role": "assistant", "content": spoken})
        await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
        await _await_send(send, {"type": "text", "token": "", "last": True})
        self._record_turn(session, caller_text, spoken)

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
            await self._speak(session, normalized, spoken, send)
            return _result(spoken)

        session._current_turn_mode = turn_mode  # type: ignore[attr-defined]
        advance_commerce_state_silent(session, normalized)

        from ..dialogue.call_closure import process_call_closure_turn

        closure = process_call_closure_turn(session, normalized)
        if closure is not None:
            spoken = self._brain.finalize_response(session, closure.reply, [])
            await self._speak(session, normalized, spoken, send)
            return _result(spoken, end_call=closure.end_call)

        twiml_greeting = bool(getattr(session, "twiml_greeting_spoken", False))
        classification = classify(
            normalized,
            session,
            turn_mode=turn_mode,
            twiml_greeting_already=twiml_greeting,
        )

        email_result = await self._handle_email_fsm(
            session, normalized, send, turn_mode=turn_mode,
        )
        if email_result is not None:
            return email_result

        from ..agent_runtime.customer_query_escalation_flow import (
            process_customer_query_escalation_turn,
        )

        esc_hint = await process_customer_query_escalation_turn(
            session, normalized, turn_mode=turn_mode,
        )
        if esc_hint.force_reply:
            spoken = self._brain.finalize_response(session, esc_hint.force_reply, [])
            await self._speak(session, normalized, spoken, send)
            logger.info("customer_query_escalation_email_capture sid=%s", sid)
            return _result(spoken)

        if classification.action == "instant" and classification.instant_reply:
            if classification.reason == "isbn_offer_prompt":
                from ..agent_runtime.isbn_short_circuit import arm_isbn_digit_collection

                arm_isbn_digit_collection(session)
            spoken = self._brain.finalize_response(session, classification.instant_reply, [])
            await self._speak(session, normalized, spoken, send)
            logger.info(
                "fast_classifier_instant sid=%s reason=%s ms=%.0f",
                sid,
                classification.reason,
                (time.monotonic() - t0) * 1000,
            )
            return _result(spoken)

        # Deterministic ISBN product hunt — bypass LLM for speed and accuracy.
        isbn_hunt = await self._try_isbn_product_hunt(
            session,
            normalized,
            send,
            turn_mode=turn_mode,
            classification=classification,
        )
        if isbn_hunt is not None:
            return isbn_hunt

        from ..agent_runtime.order_flow_state import (
            extract_order_number,
            order_intent_detected,
            try_order_enrichment_short_circuit,
        )

        is_order_turn = (
            (turn_mode or "").lower() == "order"
            or bool(extract_order_number(normalized, session, turn_mode=turn_mode))
            or classification.is_order_lookup
            or order_intent_detected(normalized)
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
                spoken = self._brain.finalize_response(session, order_hint.force_reply, [])
                await self._speak(session, normalized, spoken, send)
                logger.info("order_enrichment_short_circuit sid=%s", sid)
                return _result(spoken)

        commerce_hint = process_commerce_turn(session, normalized)
        if commerce_hint.force_reply:
            spoken = enforce_commerce_response(
                session,
                self._brain.finalize_response(session, commerce_hint.force_reply, []),
                [],
            )
            await self._speak(session, normalized, spoken, send)
            logger.info(
                "commerce_flow_short_circuit sid=%s book_added=%s version=%s",
                sid,
                commerce_hint.book_added,
                COMMERCE_FLOW_VERSION,
            )
            return _result(spoken)

        from ..agent_runtime.yes_engagement import is_bare_yes, yes_engagement_reply

        if is_bare_yes(normalized):
            engage = yes_engagement_reply(session) or ""
            spoken = self._brain.finalize_response(session, engage, [])
            await self._speak(session, normalized, spoken, send)
            logger.info("yes_engagement_short_circuit sid=%s", sid)
            return _result(spoken)

        if classification.action == "ack_then_brain" and classification.ack_reply:
            await _await_send(
                send,
                {"type": "text", "token": classification.ack_reply, "last": False, "interruptible": True},
            )

        live_context = self._build_live_context(
            session, normalized, turn_mode=turn_mode, caller_context=caller_context,
        )

        try:
            final_text, tools_used, tool_results = await self._brain.run_turn(
                session,
                normalized,
                send,
                turn_mode=turn_mode,
                use_strong_model=classification.use_strong_model,
                live_context=live_context,
                caller_context=caller_context,
            )
        except Exception as exc:
            logger.error("brain_error sid=%s err=%s", sid, type(exc).__name__)
            spoken = _OPENAI_FALLBACK
            await self._speak(session, normalized, spoken, send)
            return _result(spoken)

        if not final_text:
            spoken = _OPENAI_FALLBACK
            await self._speak(session, normalized, spoken, send)
            return _result(spoken)

        final_text = enforce_commerce_response(session, final_text, tool_results)
        spoken = self._brain.finalize_response(session, final_text, tool_results)
        await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
        await _await_send(send, {"type": "text", "token": "", "last": True})
        session.history.append({"role": "assistant", "content": spoken})
        self._record_turn(session, normalized, spoken)

        logger.info(
            "voice_commerce_complete sid=%s tools=%s chars=%d ms=%.0f reason=%s",
            sid,
            ",".join(tools_used) or "none",
            len(spoken),
            (time.monotonic() - t0) * 1000,
            classification.reason,
        )
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
