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
from collections.abc import Awaitable, Callable
from typing import Any, Optional, TYPE_CHECKING

from ..agent_runtime import llm_tools
from ..agent_runtime.openai_health import log_request_started, log_response_completed
from ..agent_runtime.output_guardrails import apply_output_guardrails
from ..agent_runtime.payment_flow_state import enforce_payment_response, parse_tool_result
from ..agent_runtime.tool_progress import TOOL_PROGRESS_ENABLED, dispatch_with_progress
from ..agent_runtime.tool_runtime_gates import replace_blocked_order_phrase
from ..runtime.tool_router import execute_batch, tool_specs_for_brain
from .openai_request_utils import log_openai_bad_request

if TYPE_CHECKING:
    from ..state.models import SafeCallerContext, SessionState

logger = logging.getLogger(__name__)

_MAX_HISTORY_MESSAGES = 40
_MAX_TOOL_ROUNDS = 3

_OPENAI_FALLBACK = (
    "I'm having a little trouble with that. "
    "Could you say that again — are you looking to buy something, check an order, or cancel an order?"
)

_STUCK_RECOVERY = (
    "Sorry, I didn't quite get that. "
    "Tell me what you need — buying a book, order status, cancellation, or something else?"
)

_ERIC_SYSTEM_PROMPT = """You are Eric, a professional SureShot Books phone seller.

You help customers:
- search books by ISBN, title, author
- search newspapers and magazines
- add products to cart
- create payment link after confirmed email/cart
- check order status
- check refund status
- answer facility policy questions
- escalate when data is missing

INTENT UNDERSTANDING (messy speech, accents, STT errors):
- Infer what the caller wants: buy/search products, order status, refund, cancellation, complaint, payment link, or facility policy.
- "ordinary" / "ordering" usually means ORDER — not a random word.
- If intent is unclear, ask ONE short question — never stay silent.
- Switch to the right tool/workflow for the intent; do not mix order lookup with product search or payment email.

CANCELLATION & COMPLAINTS:
- Order cancellation: collect name and spell-confirmed email, then forward to support with the cancellation request and order number if known.
- Do not promise cancellation on the call — support will email the customer.
- Complaints and requests for a human: same support handoff path with name + confirmed email.
- Support emails include customer name, email, and request only — never mention call IDs to the customer.

When Shopify, catalog, or order lookup cannot find the customer's item or order:
- Never invent or guess product, order, refund, or tracking data.
- For order lookups, retry or ask the caller to verify the order number — do NOT escalate to support automatically.
- Use create_product_not_found_escalation (products) or escalate_to_customer_service (orders/refunds) ONLY when the customer explicitly asks for human support or follow-up by email.
- Support handoff requires collecting and confirming the customer's name and email on the call first.

Rules:
- Sound like a real person on a live phone call — warm, natural, unhurried. Use contractions (I'm, we'll, that's).
- NEVER stay silent or give an empty reply. If unsure, ask ONE short clarifying question.
- Acknowledge the caller before the next step: "Got it", "Sure", "No problem" — then continue.
- Be warm, fast, and concise.
- Ask one question at a time.
- Use tools for all real data.
- Never invent product, price, order, refund, tracking, payment, or facility info.
- For ISBN lookups, always call search_product_by_isbn — never search_products or catalog_search for ISBN.
- For order lookups, call lookup_shopify_order_details or get_order_details with the order number only — email is optional.
- Order lookup tools return structured JSON only — YOU format speech naturally.
- When an order is found, start with "I found your order," then give product count, subtotal, shipping, and total only — speak dollar amounts naturally (e.g. "ninety dollars and ninety-nine cents").
- For refunded orders only: say status is refunded, refund notification email (speak full email), and card brand plus last four digits.
- Never read full street addresses aloud. OK to share customer name, email, general area, and card last four only.
- Answer only what the caller asks — do not volunteer extra order details, line items, or tracking unless requested.
- After a verified order lookup, speak the FULL customer email from order.customer.email when the caller asks about email or refunds (never mask it).
- For refunds when asked, include refund date, amount, refunded items, and full refund notification email from Shopify data.
- Payment cards: only card brand and last 4 digits — never full card numbers.
- Do NOT volunteer customer order history unless the caller asks — then use get_customer_order_history.
- Never read full credit card numbers — only last four digits when payment details are available.
- For order/refund details, order number alone is enough — do not ask for email verification first.
- Never read payment URLs aloud.
- Confirm email before payment link.
- Confirm cart before checkout/payment.
- For vague product requests, ask for title, author, or ISBN.
- For facility policy, use cached facility data only.
- Final answer should be natural and brief for order questions (a few short sentences); stay concise for simple product questions.
- For cart questions, read titles and copy counts from the cart state — do not guess.
- When the customer says goodbye, bye, see you, thank you and done, or clearly needs nothing else, give a brief warm closing and STOP — do not ask more questions or start new tasks.
- Use LIVE CALL STATE and call memory for everything discussed this call: books, ISBNs, quantities, orders, refunds, email, and cart. Never forget earlier turns in the same call.
- After payment link is sent, only confirm it was emailed unless the customer asks for something else.
- No markdown, no JSON, no internal tool names, no "as an AI"."""


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
        brain = (getattr(self._settings, "VOICE_BRAIN_MODEL", "") or "").strip()
        if brain:
            return brain
        return getattr(self._settings, "OPENAI_MODEL", "gpt-4o")

    def _system_message(
        self,
        session: "SessionState",
        caller_text: str = "",
        *,
        turn_mode: str = "",
        live_context: str = "",
    ) -> dict:
        state = live_context or self._build_live_context(session, caller_text, turn_mode=turn_mode)
        content = f"{_ERIC_SYSTEM_PROMPT}\n\n{state}"
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
        try:
            from ..conversation.call_memory import build_brain_context, sync_from_session
            from ..dialogue.naturalness import NaturalnessController

            sync_from_session(session)
            memory_block = build_brain_context(session)
            if memory_block:
                lines.append(memory_block)
            style = NaturalnessController.style_hint(session)
            if style:
                lines.append(f"- Tone hint (do not read aloud): {style}")
            avoid = NaturalnessController.avoid_repetition_note(session)
            if avoid:
                lines.append(f"- {avoid}")
        except Exception:  # noqa: BLE001
            pass
        if caller_text:
            try:
                from ..tools.voice_intent import normalize_voice_intent

                intent_hint = normalize_voice_intent(caller_text)
                lines.append(f"- Caller intent hint (do not read aloud): {intent_hint}")
            except Exception:  # noqa: BLE001
                pass
        return "\n".join(lines)

    @staticmethod
    def _safe_trim(history: list[dict]) -> list[dict]:
        from .openai_request_utils import repair_incomplete_tool_turns

        trimmed = repair_incomplete_tool_turns(history[-_MAX_HISTORY_MESSAGES:])
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

    @staticmethod
    def _sanitize_messages(messages: list[dict]) -> list[dict]:
        """Drop malformed history entries that would cause OpenAI BadRequest."""
        from .openai_request_utils import repair_incomplete_tool_turns

        messages = repair_incomplete_tool_turns(messages)
        valid_roles = frozenset({"system", "user", "assistant", "tool"})
        clean: list[dict] = []
        for msg in messages:
            role = msg.get("role", "")
            if role not in valid_roles:
                continue
            if role == "tool":
                if not msg.get("tool_call_id"):
                    continue
                clean.append({
                    "role": "tool",
                    "tool_call_id": msg["tool_call_id"],
                    "content": str(msg.get("content") or ""),
                })
            elif role == "assistant":
                entry: dict[str, Any] = {"role": "assistant"}
                if msg.get("content"):
                    entry["content"] = str(msg["content"])
                if msg.get("tool_calls"):
                    entry["tool_calls"] = msg["tool_calls"]
                if entry.get("content") or entry.get("tool_calls"):
                    clean.append(entry)
            else:
                content = msg.get("content")
                if content:
                    clean.append({"role": role, "content": str(content)})
        return clean

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
        messages.extend(self._sanitize_messages(self._safe_trim(session.history)))
        messages.append({"role": "user", "content": caller_text})
        return self._sanitize_messages(messages)

    async def _complete(self, messages: list[dict], model: str, sid: str):
        from ..reliability.openai_retry import call_with_retry

        client = self._get_client()
        timeout = self._settings.VOICE_OPENAI_TIMEOUT_MS / 1000
        tools = tool_specs_for_brain()

        async def _call():
            return await asyncio.wait_for(
                client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=tools,
                    tool_choice="auto",
                    temperature=0.62,
                    max_tokens=450,
                ),
                timeout=timeout,
            )

        try:
            return await call_with_retry(_call, purpose="main_commerce_brain", max_attempts=2)
        except Exception as exc:
            from openai import BadRequestError

            if isinstance(exc, BadRequestError) or "BadRequest" in type(exc).__name__:
                log_openai_bad_request(
                    logger,
                    exc,
                    sid=sid,
                    purpose="main_commerce_brain",
                    model=model,
                    messages=messages,
                    tools=tools,
                )
            raise

    async def _complete_final(self, messages: list[dict], model: str, sid: str):
        """Final spoken answer — no further tool calls."""
        from ..reliability.openai_retry import call_with_retry

        client = self._get_client()
        timeout = self._settings.VOICE_OPENAI_TIMEOUT_MS / 1000

        async def _call():
            return await asyncio.wait_for(
                client.chat.completions.create(
                    model=model,
                    messages=messages,
                    temperature=0.62,
                    max_tokens=450,
                ),
                timeout=timeout,
            )

        try:
            return await call_with_retry(_call, purpose="main_commerce_brain_final", max_attempts=2)
        except Exception as exc:
            from openai import BadRequestError

            if isinstance(exc, BadRequestError) or "BadRequest" in type(exc).__name__:
                log_openai_bad_request(
                    logger,
                    exc,
                    sid=sid,
                    purpose="main_commerce_brain_final",
                    model=model,
                    messages=messages,
                    tools=[],
                )
            raise

    async def _stream_completion_tokens(
        self,
        messages: list[dict],
        model: str,
        sid: str,
        *,
        tools: list | None = None,
        on_token: Callable[[str], Awaitable[None]] | None = None,
    ) -> tuple[str, list | None]:
        """
        Stream chat completion tokens. Returns (full_content, tool_calls_or_none).

        When tools are enabled, tokens are buffered until the stream ends — if tool
        calls appear, nothing was streamed to TTS. Otherwise on_token fires live.
        """
        from ..reliability.openai_retry import call_with_retry

        client = self._get_client()
        timeout = self._settings.VOICE_OPENAI_TIMEOUT_MS / 1000
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": 0.62,
            "max_tokens": 450,
            "stream": True,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        async def _call():
            return await asyncio.wait_for(
                client.chat.completions.create(**kwargs),
                timeout=timeout,
            )

        purpose = "main_commerce_brain_stream" if tools else "main_commerce_brain_final_stream"
        stream = await call_with_retry(_call, purpose=purpose, max_attempts=2)

        content_parts: list[str] = []
        tool_calls_acc: dict[int, dict[str, Any]] = {}
        saw_tool_calls = False
        stream_live = on_token is not None and not tools

        async for event in stream:
            if not event.choices:
                continue
            delta = event.choices[0].delta
            if delta.content:
                content_parts.append(delta.content)
                if stream_live:
                    await on_token(delta.content)
                elif on_token and not saw_tool_calls:
                    pass
            if delta.tool_calls:
                saw_tool_calls = True
                for tc in delta.tool_calls:
                    idx = tc.index if tc.index is not None else 0
                    entry = tool_calls_acc.setdefault(
                        idx,
                        {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
                    )
                    if tc.id:
                        entry["id"] = tc.id
                    if tc.function:
                        if tc.function.name:
                            entry["function"]["name"] = (
                                entry["function"]["name"] + tc.function.name
                            )
                        if tc.function.arguments:
                            entry["function"]["arguments"] = (
                                entry["function"]["arguments"] + tc.function.arguments
                            )

        content = "".join(content_parts).strip()
        if on_token and tools and not saw_tool_calls and content:
            await on_token(content)

        if not saw_tool_calls:
            return content, None

        tool_calls = [tool_calls_acc[i] for i in sorted(tool_calls_acc)]
        return content, tool_calls

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
        on_token: Callable[[str], Awaitable[None]] | None = None,
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

        tools = tool_specs_for_brain()

        try:
            for _round in range(_MAX_TOOL_ROUNDS):
                started = log_request_started(session.call_sid, model, purpose="main_commerce_brain")
                use_stream = on_token is not None and _round == 0
                if use_stream:
                    content, streamed_tools = await self._stream_completion_tokens(
                        messages,
                        model,
                        sid,
                        tools=tools,
                        on_token=on_token,
                    )
                    log_response_completed(
                        session.call_sid,
                        model,
                        response=None,
                        started_at=started,
                        purpose="main_commerce_brain_stream",
                    )
                    if streamed_tools:
                        tool_calls = streamed_tools
                        msg_content = content or None
                    elif content:
                        final = content or _STUCK_RECOVERY
                        return final, tools_used, tool_results
                    else:
                        tool_calls = None
                        msg_content = None
                else:
                    resp = await self._complete(messages, model, sid)
                    log_response_completed(
                        session.call_sid, model, response=resp, started_at=started, purpose="main_commerce_brain",
                    )
                    msg = resp.choices[0].message
                    tool_calls = getattr(msg, "tool_calls", None)
                    msg_content = msg.content

                if not tool_calls:
                    final = (msg_content or "").strip()
                    if not final:
                        final = _STUCK_RECOVERY
                    return final, tools_used, tool_results

                assistant_entry: dict[str, Any] = {
                    "role": "assistant",
                    "content": msg_content or None,
                    "tool_calls": [
                        {
                            "id": tc["id"] if isinstance(tc, dict) else tc.id,
                            "type": "function",
                            "function": {
                                "name": (
                                    tc["function"]["name"]
                                    if isinstance(tc, dict)
                                    else tc.function.name
                                ),
                                "arguments": (
                                    tc["function"]["arguments"]
                                    if isinstance(tc, dict)
                                    else tc.function.arguments
                                ),
                            },
                        }
                        for tc in tool_calls
                    ],
                }
                messages.append(assistant_entry)
                session.history.append(assistant_entry)

                parsed_calls: list[tuple[str, dict, Any]] = []
                for tc in tool_calls:
                    if isinstance(tc, dict):
                        name = tc["function"]["name"]
                        try:
                            args = json.loads(tc["function"]["arguments"] or "{}")
                        except json.JSONDecodeError:
                            args = {}
                        parsed_calls.append((name, args, tc))
                    else:
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
                    tc_id = tc["id"] if isinstance(tc, dict) else tc.id
                    tool_entry = {"role": "tool", "tool_call_id": tc_id, "content": result_str}
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
                    tc_id = tc["id"] if isinstance(tc, dict) else tc.id
                    tool_entry = {
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": result.raw_json or json.dumps(result.result),
                    }
                    messages.append(tool_entry)
                    session.history.append(tool_entry)

            # Exhausted tool rounds — one final synthesis call without tools.
            started = log_request_started(session.call_sid, model, purpose="main_commerce_brain_final")
            if on_token:
                final, _ = await self._stream_completion_tokens(
                    messages, model, sid, on_token=on_token,
                )
                log_response_completed(
                    session.call_sid,
                    model,
                    response=None,
                    started_at=started,
                    purpose="main_commerce_brain_final_stream",
                )
            else:
                resp = await self._complete_final(messages, model, sid)
                log_response_completed(
                    session.call_sid, model, response=resp, started_at=started, purpose="main_commerce_brain_final",
                )
                final = (resp.choices[0].message.content or "").strip()
            if not final:
                final = _STUCK_RECOVERY
            return final, tools_used, tool_results

        except Exception as exc:
            logger.error("brain_run_turn_error sid=%s err=%s", sid, type(exc).__name__)
            return _OPENAI_FALLBACK, tools_used, tool_results

    def finalize_response(
        self,
        session: "SessionState",
        text: str,
        tool_results: list[tuple[str, dict]],
        *,
        max_words: int | None = None,
    ) -> str:
        """Apply safety guardrails to brain output."""
        from ..email.speller import is_preserved_email_readback
        from ..safety.response_sanitizer import is_order_disclosure_text

        if is_preserved_email_readback(text):
            return text.strip()

        enforced = enforce_payment_response(session, text, tool_results)
        enforced = replace_blocked_order_phrase(enforced)
        if max_words is None:
            if is_order_disclosure_text(enforced):
                max_words = getattr(self._settings, "VOICE_ORDER_REPLY_MAX_WORDS", 120)
            else:
                max_words = getattr(self._settings, "VOICE_MAX_REPLY_WORDS", 50)
        guarded = apply_output_guardrails(
            enforced,
            max_words=max_words,
            call_sid=getattr(session, "call_sid", ""),
        )
        out = guarded.text.strip()
        if not out:
            out = _STUCK_RECOVERY
        return out
