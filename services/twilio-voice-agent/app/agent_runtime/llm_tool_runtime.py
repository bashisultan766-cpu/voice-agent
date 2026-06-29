"""
LLM_TOOL_RUNTIME — the single, clean, LLM-first voice runtime.

Flow for every caller turn (when ``VOICE_LLM_ONLY_FINAL_OUTPUT`` is true, the default):

    caller message
      -> optional session state updates (email/cart flags — no canned speech)
      -> context builder (master prompt sections + role-based history + state)
      -> OpenAI chat completion WITH tools (gpt-4o by default)
      -> [if the model requests tools] execute tools in parallel, return results
      -> ... loop until the model writes a final answer ...
      -> OpenAI writes the final spoken response (only the model speaks to caller)
      -> deterministic safety guardrails (sanitizer + length trim — not business rules)
      -> Twilio/voice response

Legacy deterministic short-circuits (commerce/isbn/payment templates) remain in the
codebase for certification/tests but are disabled for live calls when llm-only mode
is on. Tools never emit final customer-facing text; they return JSON for the model.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable, Optional, TYPE_CHECKING

from . import llm_tools
from . import openai_health
from .master_prompt import MasterPromptError, get_master_prompt
from .output_guardrails import apply_output_guardrails
from .commerce_flow_state import (
    COMMERCE_FLOW_VERSION,
    enforce_commerce_response,
    post_tool_commerce_message,
    process_commerce_turn,
)
from .payment_flow_state import (
    confirmation_prompt,
    enforce_payment_response,
    parse_tool_result,
    process_payment_turn,
    spoken_email_confirmation,
)
from ..payment.email_state import (
    EMAIL_CAPTURE_SHORT_CIRCUIT_ENABLED,
    PAYMENT_AUTO_SEND_ENABLED,
    PAYMENT_EMAIL_STATE_VERSION,
)
from .tool_progress import TOOL_PROGRESS_ENABLED, dispatch_with_progress
from .tool_runtime_gates import replace_blocked_order_phrase

if TYPE_CHECKING:
    from ..state.models import SafeCallerContext, SessionState

logger = logging.getLogger(__name__)

RUNTIME_MODE = "llm_tool_runtime"

# Conversation-history budget (role messages, excluding the system message).
_MAX_HISTORY_MESSAGES = 40
# Max tool-call rounds per turn (prevents runaway loops).
_MAX_TOOL_ROUNDS = 5
# Deterministic fallback used ONLY when OpenAI cannot answer.
_OPENAI_FALLBACK = (
    "I'm sorry, I'm having trouble accessing that right now. "
    "Could you say that again, or would you like me to connect you with our team?"
)


def llm_only_final_output_enabled(settings=None) -> bool:
    from ..config import get_settings

    s = settings or get_settings()
    return bool(getattr(s, "VOICE_LLM_ONLY_FINAL_OUTPUT", True))


def enforce_deterministic_tool_response_enabled(settings=None) -> bool:
    from ..config import get_settings

    s = settings or get_settings()
    if llm_only_final_output_enabled(s):
        return bool(getattr(s, "VOICE_ENFORCE_DETERMINISTIC_TOOL_RESPONSE", False))
    return True


def _result(answer: str, source: str = "llm_tool_runtime"):
    from .types import RuntimeTurnResult

    return RuntimeTurnResult(response_text=answer, source=source)


async def _await_send(send: Callable, msg: dict) -> None:
    out = send(msg)
    if asyncio.iscoroutine(out):
        await out


class LLMToolRuntime:
    """Single LLM-first, tool-calling runtime."""

    def __init__(self, settings=None):
        from ..config import get_settings

        self._settings = settings or get_settings()
        self._client = None

    # ── OpenAI client ─────────────────────────────────────────────────────
    def _get_client(self):
        if self._client is None:
            from openai import AsyncOpenAI

            self._client = AsyncOpenAI(api_key=self._settings.OPENAI_API_KEY)
        return self._client

    # ── Context assembly ──────────────────────────────────────────────────
    def _system_message(
        self,
        session: "SessionState",
        caller_text: str = "",
        *,
        turn_mode: str = "",
    ) -> dict:
        """Build the system message: master prompt sections + live state."""
        try:
            master = get_master_prompt()
            # Send the full prompt when it fits; section-trim only if huge.
            budget = getattr(self._settings, "VOICE_PROMPT_TOKEN_BUDGET", 4000)
            prompt = master.assemble(max_tokens=budget)
        except MasterPromptError:
            logger.error("master_prompt_missing sid=%s", session.call_sid[:6])
            prompt = (
                "You are Eric, a professional phone support agent for SureShot "
                "Books. Use tools for all business facts. Never reveal secrets. "
                "Verify identity before sharing order or refund details. Keep "
                "replies short and natural."
            )

        state = self._state_block(
            session,
            caller_text=caller_text,
            turn_mode=getattr(session, "_current_turn_mode", "") or "",
        )
        return {"role": "system", "content": f"{prompt}\n\n{state}"}

    def _state_block(
        self,
        session: "SessionState",
        caller_text: str = "",
        *,
        turn_mode: str = "",
    ) -> str:
        from ..caller.repository import mask_email

        verified = bool(getattr(session, "verified_email", False)) or bool(
            getattr(session, "verified_phone", False)
        )
        try:
            from ..cart.session import get_ledger

            cart = get_ledger(session)
            cart_line = cart.cart_summary_text()
        except Exception:  # noqa: BLE001
            cart_line = "No active cart."

        name = getattr(session, "caller_name", "") or ""
        returning = bool(getattr(session, "is_returning_caller", False))
        email_masked = (
            mask_email(session.caller_email)
            if getattr(session, "caller_email", "")
            else ""
        )
        last_order = getattr(session, "last_order_number", "") or ""
        pay_status = getattr(session, "payment_flow_status", "idle") or "idle"
        awaiting_email = bool(getattr(session, "awaiting_payment_email_confirmation", False))
        pending_pay_email = getattr(session, "pending_payment_email", "") or ""

        lines = [
            "LIVE CALL STATE (for your context — do not read aloud):",
            f"- Caller name: {name or 'unknown'}",
            f"- Returning caller (friendly only, NOT verified): {'yes' if returning else 'no'}",
            f"- Email on file (masked): {email_masked or 'none'}",
            f"- Identity verified THIS call: {'yes' if verified else 'no'}",
            f"- Cart (new purchase in progress): {cart_line}",
            f"- Last order mentioned: {last_order or 'none'}",
            f"- Payment flow status: {pay_status}",
            f"- Awaiting payment email confirmation: {'yes' if awaiting_email else 'no'}",
        ]
        if cart_line and cart_line != "No active cart." and last_order:
            lines.append(
                "- Cart is from a resumed or in-progress purchase — do NOT cite cart "
                "titles when answering about a looked-up order. Use get_order results."
            )
        if pending_pay_email:
            lines.append(
                f"- Pending payment email (unconfirmed): {pending_pay_email} — "
                "do NOT call send_payment_link until customer confirms yes."
            )
        if getattr(session, "payment_email_confirmed", False):
            lines.append("- Payment email confirmed: yes — send_payment_link allowed.")
        order_ctx = getattr(session, "order_context", "") or ""
        if order_ctx:
            lines.append(f"- Last order lookup summary: {order_ctx[:400]}")
        order_flow = getattr(session, "order_flow_status", "idle") or "idle"
        if order_flow != "idle":
            lines.append(f"- Order collection flow: {order_flow}")
        if last_order:
            on = str(last_order).lstrip("#")
            lines.append(
                f"- Active order lookup: #{on}. For follow-ups about books, status, "
                f"or price on that order, call get_order(order_number=\"{on}\")."
            )
        try:
            from .commerce_flow_state import _candidate, _status as commerce_status

            cstatus = commerce_status(session)
            candidate = _candidate(session)
            if candidate and cstatus != "idle":
                title = (candidate.get("title") or "")[:48]
                lines.append(
                    f"- Commerce flow: {cstatus}; staged book={title!r}; "
                    f"allow_add_to_cart={'yes' if getattr(session, 'commerce_allow_add', False) else 'no'}."
                )
                if getattr(session, "commerce_allow_add", False):
                    lines.append(
                        "- commerce_allow_add is TRUE — call add_to_cart now with the staged "
                        "ISBN/title/quantity; do NOT ask for email until all books are in cart."
                    )
                elif cstatus == "awaiting_quantity":
                    lines.append(
                        "- Ask how many copies, then on yes call add_to_cart."
                    )
        except Exception:  # noqa: BLE001
            pass
        try:
            from .isbn_short_circuit import isbn_context_for_state_block

            isbn_line = isbn_context_for_state_block(
                session, caller_text, turn_mode=turn_mode,
            )
            if isbn_line:
                lines.append(isbn_line)
        except Exception:  # noqa: BLE001
            pass
        try:
            from .turn_prefetch import (
                payment_groups_hint_for_state_block,
                prefetch_hint_for_state_block,
            )

            prefetch_line = prefetch_hint_for_state_block(session)
            if prefetch_line:
                lines.append(prefetch_line)
            pay_groups_line = payment_groups_hint_for_state_block(session)
            if pay_groups_line:
                lines.append(pay_groups_line)
        except Exception:  # noqa: BLE001
            pass
        try:
            from ..facility.knowledge_context import build_facility_knowledge_block

            facility_block = build_facility_knowledge_block(session, caller_text=caller_text)
            if facility_block:
                lines.append("")
                lines.append(facility_block)
        except Exception:  # noqa: BLE001
            pass
        lines.append(
            "Order numbers alone are enough to share line items (book titles), status, "
            "and totals via get_order or calculate_pricing. Ask for email or phone only "
            "before sharing shipping address, full email, or card details."
        )
        return "\n".join(lines)

    def _seed_history_from_memory(self, session: "SessionState") -> None:
        """Populate session.history from prior call memory if it is empty."""
        if session.history:
            return
        mem = getattr(session, "call_memory", None)
        user_turns = list(getattr(mem, "user_turns", []) or []) if mem else []
        asst_turns = list(getattr(mem, "assistant_turns", []) or []) if mem else []
        seeded: list[dict] = []
        for u, a in zip(user_turns, asst_turns):
            if u:
                seeded.append({"role": "user", "content": u})
            if a:
                seeded.append({"role": "assistant", "content": a})
        session.history = seeded[-_MAX_HISTORY_MESSAGES:]

    @staticmethod
    def _safe_trim(history: list[dict]) -> list[dict]:
        """
        Keep the most recent messages without orphaning tool messages.

        OpenAI rejects a 'tool' message that is not preceded by an assistant
        message containing the matching tool_call. After slicing we drop any
        leading 'tool' messages and any leading assistant message that carries
        tool_calls (its tool outputs may have been trimmed away).
        """
        trimmed = history[-_MAX_HISTORY_MESSAGES:]
        while trimmed:
            head = trimmed[0]
            if head.get("role") == "tool":
                trimmed = trimmed[1:]
                continue
            if head.get("role") == "assistant" and head.get("tool_calls"):
                trimmed = trimmed[1:]
                continue
            break
        return trimmed

    def build_messages(
        self,
        session: "SessionState",
        caller_text: str,
        *,
        turn_mode: str = "",
    ) -> list[dict]:
        self._seed_history_from_memory(session)
        messages: list[dict] = [
            self._system_message(session, caller_text=caller_text, turn_mode=turn_mode),
        ]
        messages.extend(self._safe_trim(session.history))
        messages.append({"role": "user", "content": caller_text})
        return messages

    # ── OpenAI call with retry ────────────────────────────────────────────
    async def _complete(self, messages: list[dict], sid: str):
        from ..reliability.openai_retry import call_with_retry

        settings = self._settings
        client = self._get_client()
        timeout = settings.VOICE_OPENAI_TIMEOUT_MS / 1000

        async def _call():
            return await asyncio.wait_for(
                client.chat.completions.create(
                    model=settings.OPENAI_MODEL,
                    messages=messages,
                    tools=llm_tools.tool_specs(),
                    tool_choice="auto",
                    temperature=0.6,
                    max_tokens=500,
                ),
                timeout=timeout,
            )

        return await call_with_retry(_call, purpose="llm_tool_runtime", max_attempts=2)

    async def _execute_payment_auto_send(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable[[dict], Awaitable[None]],
        *,
        sid: str,
        stage: str,
    ) -> dict:
        """Deterministic checkout + Resend after confirmed email — no OpenAI."""
        from ..payment.email_state import log_payment_flow_diagnostics
        from ..payment.payment_link_service import PAYMENT_PROGRESS_MESSAGE

        if not PAYMENT_AUTO_SEND_ENABLED:
            logger.error("payment_auto_send_disabled sid=%s stage=%s", sid, stage)
            spoken = self._finalize(
                session,
                "I have your email confirmed. I'm preparing your secure payment link now.",
            )
            session.history.append({"role": "user", "content": caller_text})
            session.history.append({"role": "assistant", "content": spoken})
            await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
            await _await_send(send, {"type": "text", "token": "", "last": True})
            self._record_turn(session, caller_text, spoken)
            return _result(spoken)

        log_payment_flow_diagnostics(session, stage=stage)
        await _await_send(
            send,
            {
                "type": "text",
                "token": PAYMENT_PROGRESS_MESSAGE,
                "last": False,
                "interruptible": True,
            },
        )
        send_raw = await llm_tools.dispatch("send_payment_link", {}, session)
        send_result = parse_tool_result(send_raw)
        spoken = enforce_payment_response(
            session,
            send_result.get("customer_message") or "",
            [("send_payment_link", send_result)],
        )
        spoken = self._finalize(session, spoken)
        session.history.append({"role": "user", "content": caller_text})
        session.history.append({"role": "assistant", "content": spoken})
        await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
        await _await_send(send, {"type": "text", "token": "", "last": True})
        self._record_turn(session, caller_text, spoken)
        logger.info(
            "llm_tool_runtime_payment_auto_send sid=%s stage=%s success=%s openai_skipped=true",
            sid,
            stage,
            bool(send_result.get("email_sent")),
        )
        return _result(spoken)

    # ── Turn handling ─────────────────────────────────────────────────────
    async def handle_turn(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable[[dict], Awaitable[None]],
        caller_context: Optional["SafeCallerContext"] = None,
        turn=None,
        *,
        assembled_turn_mode: str = "",
    ):
        sid = session.call_sid[:6]
        t0 = time.monotonic()
        openai_health.log_call_health(session.call_sid, self._settings)
        turn_mode = assembled_turn_mode or getattr(turn, "mode", "") or ""
        logger.info(
            "llm_tool_runtime_start sid=%s turn_mode=%s turn=%r",
            sid,
            turn_mode or "normal",
            caller_text[:60],
        )

        if not getattr(self._settings, "OPENAI_API_KEY", ""):
            return await self._fallback(session, caller_text, send, reason="missing_api_key")

        llm_only = llm_only_final_output_enabled(self._settings)

        session._current_turn_mode = turn_mode  # type: ignore[attr-defined]
        from .isbn_short_circuit import prepare_isbn_turn_context

        prepare_isbn_turn_context(session, caller_text, turn_mode=turn_mode)

        from .not_found_escalation_flow import process_not_found_escalation_turn

        esc_hint = await process_not_found_escalation_turn(
            session, caller_text, turn_mode=turn_mode,
        )
        if esc_hint.force_reply:
            spoken = self._finalize(session, esc_hint.force_reply)
            session.history.append({"role": "user", "content": caller_text})
            session.history.append({"role": "assistant", "content": spoken})
            await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
            await _await_send(send, {"type": "text", "token": "", "last": True})
            self._record_turn(session, caller_text, spoken)
            logger.info("support_handoff_email_capture sid=%s openai_skipped=true", sid)
            return _result(spoken)

        if llm_only:
            from .commerce_flow_state import advance_commerce_state_silent
            from .order_flow_state import prepare_order_turn_context

            advance_commerce_state_silent(session, caller_text)
            prepare_order_turn_context(session, caller_text, turn_mode=turn_mode)

        payment_hint = process_payment_turn(session, caller_text, turn_mode=turn_mode)
        if not llm_only:
            if payment_hint.force_reply:
                spoken = self._finalize(session, payment_hint.force_reply)
                session.history.append({"role": "user", "content": caller_text})
                session.history.append({"role": "assistant", "content": spoken})
                await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
                await _await_send(send, {"type": "text", "token": "", "last": True})
                self._record_turn(session, caller_text, spoken)
                logger.info(
                    "email_capture_short_circuit sid=%s stage=confirm_prompt "
                    "payment_email_state_version=%s awaiting_confirmation=%s",
                    session.call_sid[:6],
                    PAYMENT_EMAIL_STATE_VERSION,
                    bool(getattr(session, "awaiting_payment_email_confirmation", False)),
                )
                logger.info(
                    "llm_tool_runtime_payment_confirm_prompt sid=%s openai_skipped=true",
                    session.call_sid[:6],
                )
                return _result(spoken)

            if payment_hint.email_confirmed:
                return await self._execute_payment_auto_send(
                    session,
                    caller_text,
                    send,
                    sid=sid,
                    stage="auto_send_after_confirm",
                )

            from ..payment.payment_state_machine import needs_deferred_payment_auto_send

            if needs_deferred_payment_auto_send(session):
                logger.warning(
                    "payment_deferred_auto_send sid=%s confirmed_email_present=true "
                    "payment_link_sent=false",
                    sid,
                )
                return await self._execute_payment_auto_send(
                    session,
                    caller_text,
                    send,
                    sid=sid,
                    stage="deferred_auto_send",
                )
        elif payment_hint.email_confirmed:
            logger.info(
                "llm_only_payment_email_confirmed sid=%s send_deferred_to_llm_tools=true",
                sid,
            )

        if not llm_only:
            from .fast_greeting import fast_greeting_reply

            greet = fast_greeting_reply(session, caller_text)
            if greet:
                spoken = self._finalize(session, greet)
                session.history.append({"role": "user", "content": caller_text})
                session.history.append({"role": "assistant", "content": spoken})
                await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
                await _await_send(send, {"type": "text", "token": "", "last": True})
                self._record_turn(session, caller_text, spoken)
                logger.info("fast_greeting_short_circuit sid=%s openai_skipped=true", sid)
                return _result(spoken)

            from .isbn_short_circuit import (
                conversational_ack_reply,
                is_conversational_ack,
                try_isbn_short_circuit,
                try_title_catalog_short_circuit,
            )

            if is_conversational_ack(caller_text):
                ack = conversational_ack_reply(session, turn_mode=turn_mode)
                if ack:
                    spoken = self._finalize(session, ack)
                    session.history.append({"role": "user", "content": caller_text})
                    session.history.append({"role": "assistant", "content": spoken})
                    await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
                    await _await_send(send, {"type": "text", "token": "", "last": True})
                    self._record_turn(session, caller_text, spoken)
                    logger.info("conversational_ack_short_circuit sid=%s openai_skipped=true", sid)
                    return _result(spoken)

            isbn_hint = await try_isbn_short_circuit(session, caller_text, turn_mode=turn_mode)
            if not isbn_hint:
                isbn_hint = await try_title_catalog_short_circuit(
                    session, caller_text, turn_mode=turn_mode,
                )
            if isbn_hint:
                spoken = self._finalize(session, isbn_hint.force_reply)
                session.history.append({"role": "user", "content": caller_text})
                session.history.append({"role": "assistant", "content": spoken})
                await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
                await _await_send(send, {"type": "text", "token": "", "last": True})
                self._record_turn(session, caller_text, spoken)
                logger.info(
                    "isbn_short_circuit sid=%s isbn=%s openai_skipped=true",
                    sid,
                    isbn_hint.isbn or "partial",
                )
                return _result(spoken)

            from .order_flow_state import (
                ORDER_FLOW_VERSION,
                extract_order_number,
                process_order_turn,
                try_order_enrichment_short_circuit,
            )

            order_collect = process_order_turn(session, caller_text, turn_mode=turn_mode)
            if order_collect.force_reply:
                spoken = self._finalize(session, order_collect.force_reply)
                session.history.append({"role": "user", "content": caller_text})
                session.history.append({"role": "assistant", "content": spoken})
                await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
                await _await_send(send, {"type": "text", "token": "", "last": True})
                self._record_turn(session, caller_text, spoken)
                logger.info(
                    "order_flow_collect sid=%s version=%s openai_skipped=true",
                    sid,
                    ORDER_FLOW_VERSION,
                )
                return _result(spoken)

            if extract_order_number(caller_text, session, turn_mode=turn_mode) or turn_mode == "order":
                order_enriched = await try_order_enrichment_short_circuit(
                    session, caller_text, turn_mode=turn_mode,
                )
                if order_enriched and order_enriched.force_reply:
                    spoken = self._finalize(session, order_enriched.force_reply)
                    session.history.append({"role": "user", "content": caller_text})
                    session.history.append({"role": "assistant", "content": spoken})
                    await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
                    await _await_send(send, {"type": "text", "token": "", "last": True})
                    self._record_turn(session, caller_text, spoken)
                    logger.info(
                        "order_parallel_short_circuit sid=%s enriched=%s openai_skipped=true",
                        sid,
                        order_enriched.enrichment_done,
                    )
                    return _result(spoken)

            commerce_hint = process_commerce_turn(session, caller_text)
            if commerce_hint.force_reply:
                spoken = self._finalize(session, commerce_hint.force_reply)
                session.history.append({"role": "user", "content": caller_text})
                session.history.append({"role": "assistant", "content": spoken})
                await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
                await _await_send(send, {"type": "text", "token": "", "last": True})
                self._record_turn(session, caller_text, spoken)
                logger.info(
                    "commerce_flow_short_circuit sid=%s book_added=%s version=%s openai_skipped=true",
                    session.call_sid[:6],
                    commerce_hint.book_added,
                    COMMERCE_FLOW_VERSION,
                )
                return _result(spoken)

            from .yes_engagement import is_bare_yes, yes_engagement_reply

            if is_bare_yes(caller_text):
                engage = yes_engagement_reply(session)
                spoken = self._finalize(session, engage or "")
                session.history.append({"role": "user", "content": caller_text})
                session.history.append({"role": "assistant", "content": spoken})
                await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
                await _await_send(send, {"type": "text", "token": "", "last": True})
                self._record_turn(session, caller_text, spoken)
                logger.info(
                    "yes_engagement_short_circuit sid=%s openai_skipped=true",
                    session.call_sid[:6],
                )
                return _result(spoken)

            if EMAIL_CAPTURE_SHORT_CIRCUIT_ENABLED and turn_mode == "email":
                from ..payment.payment_state_machine import (
                    capture_payment_email,
                    email_capture_context_active,
                    extract_email_from_text,
                )

                email_only = extract_email_from_text(caller_text, session)
                if email_only and email_capture_context_active(session, turn_mode):
                    hint = capture_payment_email(session, email_only, raw_text=caller_text)
                    spoken = self._finalize(session, hint.force_reply or "")
                    session.history.append({"role": "user", "content": caller_text})
                    session.history.append({"role": "assistant", "content": spoken})
                    await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
                    await _await_send(send, {"type": "text", "token": "", "last": True})
                    self._record_turn(session, caller_text, spoken)
                    logger.info(
                        "email_capture_short_circuit sid=%s stage=email_mode_fallback openai_skipped=true",
                        sid,
                    )
                    return _result(spoken)
                logger.error(
                    "email_capture_miss sid=%s turn_mode=email payment_context=%s "
                    "payment_email_state_version=%s — OpenAI WILL run",
                    sid,
                    email_capture_context_active(session, turn_mode),
                    PAYMENT_EMAIL_STATE_VERSION,
                )
        else:
            logger.info(
                "llm_only_final_output sid=%s turn_mode=%s openai_required=true",
                sid,
                turn_mode or "normal",
            )

        from .turn_prefetch import run_turn_prefetch

        max_prefetch = int(getattr(self._settings, "VOICE_PREFETCH_MAX_WAIT_MS", 400) or 400)
        await run_turn_prefetch(
            session,
            caller_text,
            turn_mode=turn_mode,
            max_wait_ms=max_prefetch,
        )

        messages = self.build_messages(session, caller_text, turn_mode=turn_mode)
        # Persist the user turn immediately so history stays consistent.
        session.history.append({"role": "user", "content": caller_text})

        final_text = ""
        tools_used: list[str] = []
        tool_results: list[tuple[str, dict]] = []
        try:
            final_text, tools_used, tool_results = await self._run_tool_loop(
                session, messages, sid, send,
            )
        except Exception as exc:  # noqa: BLE001 — never break the call
            openai_health.log_error(session.call_sid, exc, purpose="llm_tool_runtime")
            return await self._fallback(session, caller_text, send, reason="openai_error")

        if not final_text:
            return await self._fallback(session, caller_text, send, reason="empty_response")

        if enforce_deterministic_tool_response_enabled(self._settings):
            final_text = enforce_payment_response(session, final_text, tool_results)
            final_text = enforce_commerce_response(session, final_text, tool_results)
            commerce_followup = post_tool_commerce_message(session, tool_results)
            if commerce_followup:
                final_text = commerce_followup

        spoken = self._finalize(session, final_text)
        await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
        await _await_send(send, {"type": "text", "token": "", "last": True})

        # Persist assistant turn + durable memory.
        session.history.append({"role": "assistant", "content": spoken})
        self._record_turn(session, caller_text, spoken)

        total_ms = (time.monotonic() - t0) * 1000
        logger.info(
            "llm_tool_runtime_complete sid=%s tools=%s chars=%d total_ms=%.0f",
            sid, ",".join(tools_used) or "none", len(spoken), total_ms,
        )
        return _result(spoken)

    async def _run_tool_loop(
        self,
        session: "SessionState",
        messages: list[dict],
        sid: str,
        send: Optional[Callable] = None,
    ) -> tuple[str, list[str], list[tuple[str, dict]]]:
        """Run the OpenAI tool-calling loop. Returns (final_text, tools_used, parsed_results)."""
        tools_used: list[str] = []
        tool_results: list[tuple[str, dict]] = []

        for round_idx in range(_MAX_TOOL_ROUNDS):
            started = openai_health.log_request_started(
                session.call_sid, self._settings.OPENAI_MODEL, purpose="llm_tool_runtime",
            )
            resp = await self._complete(messages, sid)
            openai_health.log_response_completed(
                session.call_sid, self._settings.OPENAI_MODEL,
                response=resp, started_at=started, purpose="llm_tool_runtime",
            )
            choice = resp.choices[0]
            msg = choice.message
            tool_calls = getattr(msg, "tool_calls", None)

            if not tool_calls:
                return (msg.content or "").strip(), tools_used, tool_results

            # Record the assistant tool-call request, then execute tools.
            assistant_entry: dict[str, Any] = {
                "role": "assistant",
                "content": msg.content or None,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                    }
                    for tc in tool_calls
                ],
            }
            messages.append(assistant_entry)
            session.history.append(assistant_entry)

            async def _dispatch_one(tc) -> tuple[Any, str]:
                name = tc.function.name
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                result_str = await dispatch_with_progress(
                    llm_tools.dispatch,
                    name,
                    args,
                    session,
                    send if TOOL_PROGRESS_ENABLED else None,
                    self._settings,
                    sid,
                )
                return tc, name, result_str

            if len(tool_calls) > 1:
                logger.info(
                    "llm_tool_parallel_dispatch sid=%s count=%d",
                    sid,
                    len(tool_calls),
                )
                dispatched = await asyncio.gather(
                    *[_dispatch_one(tc) for tc in tool_calls],
                    return_exceptions=True,
                )
                for item in dispatched:
                    if isinstance(item, Exception):
                        logger.warning("llm_tool_parallel_error sid=%s err=%s", sid, item)
                        continue
                    tc, name, result_str = item
                    tools_used.append(name)
                    tool_results.append((name, parse_tool_result(result_str)))
                    tool_entry = {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": result_str,
                    }
                    messages.append(tool_entry)
                    session.history.append(tool_entry)
                continue

            for tc in tool_calls:
                _tc, name, result_str = await _dispatch_one(tc)
                tools_used.append(name)
                tool_results.append((name, parse_tool_result(result_str)))
                tool_entry = {
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result_str,
                }
                messages.append(tool_entry)
                session.history.append(tool_entry)

        # Tool rounds exhausted — ask the model for a final answer without tools.
        logger.warning("llm_tool_runtime_max_rounds sid=%s", sid)
        try:
            client = self._get_client()
            resp = await asyncio.wait_for(
                client.chat.completions.create(
                    model=self._settings.OPENAI_MODEL,
                    messages=messages,
                    temperature=0.6,
                    max_tokens=200,
                ),
                timeout=self._settings.VOICE_OPENAI_TIMEOUT_MS / 1000,
            )
            return (resp.choices[0].message.content or "").strip(), tools_used, tool_results
        except Exception:  # noqa: BLE001
            return "", tools_used, tool_results

    # ── Finalisation + safety ─────────────────────────────────────────────
    def _finalize(self, session: "SessionState", text: str) -> str:
        from ..safety.response_sanitizer import sanitize_customer_response

        if not llm_only_final_output_enabled(self._settings):
            confirm = spoken_email_confirmation(session)
            if confirm:
                text = confirm
            else:
                text = replace_blocked_order_phrase(text or "")
        else:
            text = replace_blocked_order_phrase(text or "")

        guarded = apply_output_guardrails(
            text,
            max_words=getattr(self._settings, "VOICE_MAX_REPLY_WORDS", 50) + 40,
            call_sid=session.call_sid,
        )
        sanitized = sanitize_customer_response(
            guarded.text,
            intent="llm",
            call_sid=session.call_sid,
            payment_sent=bool(
                (getattr(session, "payment_flow_result", {}) or {}).get("email_sent")
            ),
        )
        return sanitized.text

    def _record_turn(self, session: "SessionState", caller_text: str, spoken: str) -> None:
        # Keep history bounded.
        if len(session.history) > _MAX_HISTORY_MESSAGES * 2:
            session.history = session.history[-_MAX_HISTORY_MESSAGES:]
        try:
            from ..safety.response_sanitizer import log_assistant_response
            from .call_memory_manager import CallMemoryManager

            log_assistant_response(spoken, call_sid=session.call_sid, intent="llm")
            CallMemoryManager.update_after_turn(session, caller_text, spoken, "llm")
        except Exception:  # noqa: BLE001 — memory is best-effort
            logger.debug("record_turn_skipped sid=%s", session.call_sid[:6])
        try:
            from ..conversation.call_memory import extract_durable_facts

            extract_durable_facts(session, caller_text)
        except Exception:  # noqa: BLE001
            pass

    async def _fallback(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        reason: str,
    ):
        """Deterministic safe fallback — only used when OpenAI cannot answer."""
        logger.error("llm_tool_runtime_fallback sid=%s reason=%s", session.call_sid[:6], reason)
        text = _OPENAI_FALLBACK
        await _await_send(send, {"type": "text", "token": text, "last": False, "interruptible": True})
        await _await_send(send, {"type": "text", "token": "", "last": True})
        try:
            from .call_memory_manager import CallMemoryManager

            CallMemoryManager.update_after_turn(session, caller_text, text, "fallback")
        except Exception:  # noqa: BLE001
            pass
        return _result(text, source="fallback")


_runtime: Optional[LLMToolRuntime] = None


def get_llm_tool_runtime(settings=None) -> LLMToolRuntime:
    global _runtime
    if _runtime is None:
        _runtime = LLMToolRuntime(settings=settings)
    elif settings is not None:
        _runtime._settings = settings
    return _runtime


def is_llm_tool_runtime_mode(settings=None) -> bool:
    from ..config import get_settings

    s = settings or get_settings()
    return getattr(s, "VOICE_AGENT_RUNTIME_MODE", "") == RUNTIME_MODE
