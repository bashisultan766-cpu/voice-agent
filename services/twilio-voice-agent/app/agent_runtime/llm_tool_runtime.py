"""
LLM_TOOL_RUNTIME — the single, clean, LLM-first voice runtime.

Flow for every caller turn:

    caller message
      -> context builder (master prompt sections + role-based history + state)
      -> OpenAI chat completion WITH tools
      -> [if the model requests tools] execute tools, return results to the model
      -> ... loop until the model writes a final answer ...
      -> OpenAI writes the final spoken response
      -> deterministic safety guardrails (sanitizer + output guardrails)
      -> Twilio/voice response

Design rules honoured here:
* Every normal caller question reaches OpenAI first. There is no regex fast path,
  canned-answer template, JSON-only intent classifier, or deterministic business
  resolver in front of the model.
* Tools are real OpenAI function calls, validated with Pydantic, backed by the
  existing hardened Shopify/cart/email logic.
* Conversation memory is role-based (system / user / assistant / tool), not a
  flattened text blob, and is persisted on ``session.history``.
* No secret is ever logged. Order/refund PII is gated by the tools'
  verification rules. The final answer passes deterministic guardrails.
* If OpenAI is unavailable, a deterministic safe fallback is spoken (the only
  place a non-LLM customer answer is allowed).
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
from .payment_flow_state import (
    enforce_payment_response,
    parse_tool_result,
    process_payment_turn,
    spoken_email_confirmation,
)
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
    def _system_message(self, session: "SessionState") -> dict:
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

        state = self._state_block(session)
        return {"role": "system", "content": f"{prompt}\n\n{state}"}

    def _state_block(self, session: "SessionState") -> str:
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
            f"- Cart: {cart_line}",
            f"- Last order mentioned: {last_order or 'none'}",
            f"- Payment flow status: {pay_status}",
            f"- Awaiting payment email confirmation: {'yes' if awaiting_email else 'no'}",
        ]
        if pending_pay_email:
            lines.append(
                f"- Pending payment email (unconfirmed): {pending_pay_email} — "
                "do NOT call send_payment_link until customer confirms yes."
            )
        if getattr(session, "payment_email_confirmed", False):
            lines.append("- Payment email confirmed: yes — send_payment_link allowed.")
        lines.append(
            "If identity is not verified this call, you must ask for the email or "
            "phone on the order before sharing any order or refund details."
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

    def build_messages(self, session: "SessionState", caller_text: str) -> list[dict]:
        self._seed_history_from_memory(session)
        messages: list[dict] = [self._system_message(session)]
        messages.extend(self._safe_trim(session.history))
        messages.append({"role": "user", "content": caller_text})
        return messages

    # ── OpenAI call with retry ────────────────────────────────────────────
    async def _complete(self, messages: list[dict], sid: str):
        from tenacity import (
            retry,
            retry_if_exception_type,
            stop_after_attempt,
            wait_exponential,
        )

        settings = self._settings
        client = self._get_client()
        timeout = settings.VOICE_OPENAI_TIMEOUT_MS / 1000

        @retry(
            reraise=True,
            stop=stop_after_attempt(2),
            wait=wait_exponential(multiplier=0.3, max=1.5),
            retry=retry_if_exception_type(Exception),
        )
        async def _call():
            return await asyncio.wait_for(
                client.chat.completions.create(
                    model=settings.OPENAI_MODEL,
                    messages=messages,
                    tools=llm_tools.tool_specs(),
                    tool_choice="auto",
                    temperature=0.6,
                    max_tokens=400,
                ),
                timeout=timeout,
            )

        return await _call()

    # ── Turn handling ─────────────────────────────────────────────────────
    async def handle_turn(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable[[dict], Awaitable[None]],
        caller_context: Optional["SafeCallerContext"] = None,
        turn=None,
    ):
        sid = session.call_sid[:6]
        t0 = time.monotonic()
        openai_health.log_call_health(session.call_sid, self._settings)
        logger.info("llm_tool_runtime_start sid=%s turn=%r", sid, caller_text[:60])

        if not getattr(self._settings, "OPENAI_API_KEY", ""):
            return await self._fallback(session, caller_text, send, reason="missing_api_key")

        payment_hint = process_payment_turn(session, caller_text)
        if payment_hint.force_reply:
            spoken = self._finalize(session, payment_hint.force_reply)
            session.history.append({"role": "user", "content": caller_text})
            session.history.append({"role": "assistant", "content": spoken})
            await _await_send(send, {"type": "text", "token": spoken, "last": False, "interruptible": True})
            await _await_send(send, {"type": "text", "token": "", "last": True})
            self._record_turn(session, caller_text, spoken)
            logger.info(
                "llm_tool_runtime_payment_confirm_prompt sid=%s",
                session.call_sid[:6],
            )
            return _result(spoken)

        messages = self.build_messages(session, caller_text)
        # Persist the user turn immediately so history stays consistent.
        session.history.append({"role": "user", "content": caller_text})

        final_text = ""
        tools_used: list[str] = []
        tool_results: list[tuple[str, dict]] = []
        try:
            final_text, tools_used, tool_results = await self._run_tool_loop(session, messages, sid)
        except Exception as exc:  # noqa: BLE001 — never break the call
            openai_health.log_error(session.call_sid, exc, purpose="llm_tool_runtime")
            return await self._fallback(session, caller_text, send, reason="openai_error")

        if not final_text:
            return await self._fallback(session, caller_text, send, reason="empty_response")

        final_text = enforce_payment_response(session, final_text, tool_results)

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
        self, session: "SessionState", messages: list[dict], sid: str
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

            for tc in tool_calls:
                name = tc.function.name
                tools_used.append(name)
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                result_str = await llm_tools.dispatch(name, args, session)
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

        confirm = spoken_email_confirmation(session)
        if confirm:
            text = confirm
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
