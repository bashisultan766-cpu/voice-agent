"""
Main Commerce Brain — central LLM decision-maker for SureShot Books voice sales.

Uses fast model (gpt-4o-mini) for normal commerce; strong model (gpt-4o) for
complex multi-product, facility, and refund reasoning.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable, Optional, TYPE_CHECKING

from ..agent_runtime import llm_tools
from ..agent_runtime.master_prompt import MasterPromptError, get_master_prompt
from ..agent_runtime.openai_health import log_call_health, log_error, log_request_started, log_response_completed
from ..agent_runtime.output_guardrails import apply_output_guardrails
from ..agent_runtime.payment_flow_state import enforce_payment_response, parse_tool_result
from ..agent_runtime.tool_progress import TOOL_PROGRESS_ENABLED, dispatch_with_progress
from ..agent_runtime.tool_runtime_gates import replace_blocked_order_phrase
from ..runtime.tool_router import execute_batch, tool_specs_for_brain

if TYPE_CHECKING:
    from ..state.models import SafeCallerContext, SessionState

logger = logging.getLogger(__name__)

_MAX_HISTORY_MESSAGES = 40
_MAX_TOOL_ROUNDS = 5

_ERIC_SYSTEM_RULES = """You are Eric, a professional SureShot Books phone seller.
You sound human, fast, concise, and helpful.
You sell books, newspapers, magazines, and subscriptions through Shopify.
You use tools for all real commerce data.
Never invent availability, price, order status, refund status, tracking, delivery, or policy.
Ask one question at a time.
Keep responses to 1-2 short sentences.
Do not read URLs aloud.
Confirm emails before sending payment links.
Confirm cart before checkout.
Use Shopify data only for products, orders, refunds, and payment links.
Use facility policy data only for facility restrictions.
Escalate when data is missing or uncertain.
No markdown, no JSON, no internal tool names, no "as an AI"."""


class MainCommerceBrain:
    """Single-brain LLM agent with tool access for live voice commerce."""

    def __init__(self, settings=None):
        from ..config import get_settings

        self._settings = settings or get_settings()
        self._client = None

    def _get_client(self):
        if self._client is None:
            from openai import AsyncOpenAI

            self._client = AsyncOpenAI(api_key=self._settings.OPENAI_API_KEY)
        return self._client

    def _select_model(self, *, use_strong: bool = False) -> str:
        if use_strong:
            return getattr(self._settings, "OPENAI_STRONG_MODEL", "gpt-4o")
        fast = getattr(self._settings, "OPENAI_FAST_MODEL", "gpt-4o-mini")
        return fast or getattr(self._settings, "OPENAI_MODEL", "gpt-4o")

    def _system_message(
        self,
        session: "SessionState",
        caller_text: str = "",
        *,
        turn_mode: str = "",
        live_context: str = "",
    ) -> dict:
        try:
            master = get_master_prompt()
            budget = getattr(self._settings, "VOICE_PROMPT_TOKEN_BUDGET", 4000)
            prompt = master.assemble(max_tokens=budget)
        except MasterPromptError:
            prompt = _ERIC_SYSTEM_RULES

        state = live_context or self._build_live_context(session, caller_text, turn_mode=turn_mode)
        content = f"{_ERIC_SYSTEM_RULES}\n\n{prompt}\n\n{state}"
        return {"role": "system", "content": content}

    def _build_live_context(
        self,
        session: "SessionState",
        caller_text: str = "",
        *,
        turn_mode: str = "",
    ) -> str:
        from ..caller.repository import mask_email
        from ..cart.commerce_cart_service import CommerceCartService
        from ..email.voice_email_capture import VoiceEmailCapture

        cart = CommerceCartService(session)
        email_cap = VoiceEmailCapture(session)
        summary = cart.get_summary()

        verified = bool(getattr(session, "verified_email", False)) or bool(
            getattr(session, "verified_phone", False)
        )
        lines = [
            "LIVE CALL STATE (context only — do not read aloud):",
            f"- Caller: {getattr(session, 'caller_name', '') or 'unknown'}",
            f"- Identity verified this call: {'yes' if verified else 'no'}",
            f"- Cart: {summary.summary_text or 'empty'}",
            f"- Payment flow: {getattr(session, 'payment_flow_status', 'idle')}",
            f"- Email confirmed: {'yes' if email_cap.is_verified else 'no'}",
            f"- Pending email: {mask_email(email_cap.pending_email) if email_cap.pending_email else 'none'}",
            f"- Awaiting email confirm: {'yes' if getattr(session, 'awaiting_payment_email_confirmation', False) else 'no'}",
            f"- Last order: {getattr(session, 'last_order_number', '') or 'none'}",
            f"- Commerce flow: {getattr(session, 'commerce_flow_status', 'idle')}",
        ]
        if getattr(session, "payment_email_confirmed", False):
            lines.append("- send_payment_link is allowed after cart confirmed.")
        if getattr(session, "awaiting_cart_confirmation", False):
            lines.append("- Awaiting cart confirmation before checkout.")
        return "\n".join(lines)

    @staticmethod
    def _safe_trim(history: list[dict]) -> list[dict]:
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
        live_context: str = "",
    ) -> list[dict]:
        messages: list[dict] = [
            self._system_message(
                session,
                caller_text,
                turn_mode=turn_mode,
                live_context=live_context,
            ),
        ]
        messages.extend(self._safe_trim(session.history))
        messages.append({"role": "user", "content": caller_text})
        return messages

    async def _complete(self, messages: list[dict], model: str, sid: str):
        from ..reliability.openai_retry import call_with_retry

        client = self._get_client()
        timeout = self._settings.VOICE_OPENAI_TIMEOUT_MS / 1000

        async def _call():
            return await asyncio.wait_for(
                client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=tool_specs_for_brain(),
                    tool_choice="auto",
                    temperature=0.5,
                    max_tokens=400,
                ),
                timeout=timeout,
            )

        return await call_with_retry(_call, purpose="main_commerce_brain", max_attempts=2)

    async def run_turn(
        self,
        session: "SessionState",
        caller_text: str,
        send: Optional[Callable[[dict], Awaitable[None]]] = None,
        *,
        turn_mode: str = "",
        use_strong_model: bool = False,
        live_context: str = "",
        caller_context: Optional["SafeCallerContext"] = None,
    ) -> tuple[str, list[str], list[tuple[str, dict]]]:
        """
        Run the brain tool loop and return (final_text, tools_used, tool_results).
        """
        sid = (session.call_sid or "")[:6]
        model = self._select_model(use_strong=use_strong_model)
        messages = self.build_messages(
            session,
            caller_text,
            turn_mode=turn_mode,
            live_context=live_context,
        )
        session.history.append({"role": "user", "content": caller_text})

        tools_used: list[str] = []
        tool_results: list[tuple[str, dict]] = []

        for _round in range(_MAX_TOOL_ROUNDS):
            started = log_request_started(session.call_sid, model, purpose="main_commerce_brain")
            resp = await self._complete(messages, model, sid)
            log_response_completed(
                session.call_sid, model, response=resp, started_at=started, purpose="main_commerce_brain",
            )
            msg = resp.choices[0].message
            tool_calls = getattr(msg, "tool_calls", None)

            if not tool_calls:
                final = (msg.content or "").strip()
                return final, tools_used, tool_results

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

            parsed_calls: list[tuple[str, dict, Any]] = []
            for tc in tool_calls:
                name = tc.function.name
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                parsed_calls.append((name, args, tc))

            if len(parsed_calls) == 1 and send and TOOL_PROGRESS_ENABLED:
                name, args, tc = parsed_calls[0]
                result_str = await dispatch_with_progress(
                    llm_tools.dispatch,
                    name,
                    args,
                    session,
                    send,
                    self._settings,
                    sid,
                )
                tools_used.append(name)
                parsed = parse_tool_result(result_str)
                tool_results.append((name, parsed))
                tool_entry = {"role": "tool", "tool_call_id": tc.id, "content": result_str}
                messages.append(tool_entry)
                session.history.append(tool_entry)
                continue

            batch = await execute_batch(
                [(n, a) for n, a, _ in parsed_calls],
                session,
                timeout_ms=getattr(self._settings, "VOICE_TOOL_TIMEOUT_MS", 2500),
            )
            for (name, _args, tc), result in zip(parsed_calls, batch.results):
                tools_used.append(name)
                tool_results.append((name, result.result))
                tool_entry = {
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result.raw_json or json.dumps(result.result),
                }
                messages.append(tool_entry)
                session.history.append(tool_entry)

        return "", tools_used, tool_results

    def finalize_response(
        self,
        session: "SessionState",
        text: str,
        tool_results: list[tuple[str, dict]],
    ) -> str:
        """Apply safety guardrails to brain output."""
        enforced = enforce_payment_response(session, text, tool_results)
        enforced = replace_blocked_order_phrase(enforced)
        max_words = getattr(self._settings, "VOICE_MAX_REPLY_WORDS", 50)
        guarded = apply_output_guardrails(enforced, max_words=max_words)
        return guarded.text.strip()
