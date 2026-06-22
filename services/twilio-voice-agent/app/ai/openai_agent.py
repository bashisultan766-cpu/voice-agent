"""
Streaming OpenAI agent for Twilio ConversationRelay.

Protocol:
  - Text tokens are yielded as they stream so the WebSocket handler can forward
    them to Twilio immediately (low latency).
  - Tool calls are accumulated from streaming chunks, executed concurrently,
    and a filler phrase is sent to Twilio while tools run.
  - The conversation loops until the model produces a `stop` finish_reason
    (or the safety iteration cap is reached).

Usage:
    async for event in run_agent_turn(session, user_text, settings, caller_context=ctx):
        if event["type"] == "text_token":
            await ws.send_json({"type": "text", "token": event["token"], "last": False, ...})
        elif event["type"] == "turn_done":
            await ws.send_json({"type": "text", "token": "", "last": True})
        elif event["type"] == "filler":
            await ws.send_json({"type": "text", "token": event["token"], "last": False, ...})
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncGenerator, Any, Optional, TYPE_CHECKING

from openai import AsyncOpenAI

from ..config import get_settings
from ..state.models import SessionState
from ..ai.system_prompt import build_system_message
from ..ai.tool_schemas import TOOL_SCHEMAS
from ..tools import registry as tool_registry

if TYPE_CHECKING:
    from ..state.models import SafeCallerContext

logger = logging.getLogger(__name__)

# Maximum conversation history items kept to avoid ballooning context.
_MAX_HISTORY = 20
# Maximum tool-call rounds per turn (prevents runaway loops).
_MAX_TOOL_ITERATIONS = 5
# Filler phrase spoken while Shopify tools are running.
_FILLER = "Let me check that for you."


def _trim_history(history: list[dict]) -> list[dict]:
    """Keep the system message + the most recent _MAX_HISTORY non-system entries."""
    system = [m for m in history if m.get("role") == "system"]
    other = [m for m in history if m.get("role") != "system"]
    if len(other) > _MAX_HISTORY:
        other = other[-_MAX_HISTORY:]
    return system + other


def _get_client(api_key: str) -> AsyncOpenAI:
    return AsyncOpenAI(api_key=api_key)


def _inject_router_context(messages: list[dict], router_context: str) -> list[dict]:
    """Prepend router context to the last user message (first LLM call only)."""
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            enriched = {
                "role": "user",
                "content": f"{router_context}\n\nCaller says: {messages[i]['content']}",
            }
            return list(messages[:i]) + [enriched] + list(messages[i + 1:])
    return list(messages)


async def run_agent_turn(
    session: SessionState,
    user_text: str,
    settings=None,
    caller_context: Optional["SafeCallerContext"] = None,
    router_context: Optional[str] = None,
) -> AsyncGenerator[dict[str, Any], None]:
    """
    Async generator that yields events for one caller turn.

    Event types:
      {"type": "filler",      "token": str}  — filler phrase before tool execution
      {"type": "text_token",  "token": str}  — streaming LLM text token
      {"type": "turn_done"}                  — turn complete; caller can send last=true

    caller_context: optional SafeCallerContext injected into system prompt.
    router_context: optional compact pre-processing context injected into the
        first user message only (not persisted in history).
    """
    if settings is None:
        settings = get_settings()

    client = _get_client(settings.OPENAI_API_KEY)

    # Build system message on first turn only; subsequent turns keep the same one.
    if not session.history or session.history[0].get("role") != "system":
        session.history.insert(
            0,
            build_system_message(
                store_domain=session.store_domain,
                caller_context=caller_context,
                max_reply_words=settings.VOICE_MAX_REPLY_WORDS,
            ),
        )

    session.history.append({"role": "user", "content": user_text})
    session.turn_count += 1

    iteration = 0

    while iteration < _MAX_TOOL_ITERATIONS:
        iteration += 1
        messages = _trim_history(session.history)

        # Inject router context into the first LLM call only (not stored in history).
        if iteration == 1 and router_context:
            messages = _inject_router_context(messages, router_context)

        # --- Stream one LLM response ---
        tool_calls_acc: dict[int, dict] = {}  # index → {id, name, args}
        text_tokens: list[str] = []
        finish_reason: str | None = None

        try:
            stream = await client.chat.completions.create(
                model=settings.OPENAI_MODEL,
                messages=messages,
                tools=TOOL_SCHEMAS,
                tool_choice="auto",
                stream=True,
                max_tokens=400,
                temperature=0.7,
                timeout=settings.VOICE_OPENAI_TIMEOUT_MS / 1000,
            )

            async for chunk in stream:
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                delta = choice.delta

                # Text token → yield immediately for low-latency streaming.
                if delta.content:
                    text_tokens.append(delta.content)
                    yield {"type": "text_token", "token": delta.content}

                # Accumulate tool call deltas (may arrive in many chunks).
                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index
                        if idx not in tool_calls_acc:
                            tool_calls_acc[idx] = {"id": "", "name": "", "args": ""}
                        if tc.id:
                            tool_calls_acc[idx]["id"] = tc.id
                        if tc.function:
                            if tc.function.name:
                                tool_calls_acc[idx]["name"] += tc.function.name
                            if tc.function.arguments:
                                tool_calls_acc[idx]["args"] += tc.function.arguments

                if choice.finish_reason:
                    finish_reason = choice.finish_reason

        except asyncio.CancelledError:
            logger.info("Agent turn cancelled (caller interrupted)")
            return
        except Exception as exc:
            logger.exception("OpenAI streaming error: %s", exc)
            yield {"type": "text_token", "token": "I'm sorry, I had a technical problem. Could you repeat that?"}
            yield {"type": "turn_done"}
            return

        turn_text = "".join(text_tokens)

        # --- No tool calls → turn is complete ---
        if not tool_calls_acc or finish_reason == "stop":
            if turn_text:
                session.history.append({"role": "assistant", "content": turn_text})
            yield {"type": "turn_done"}
            return

        # --- Tool calls needed ---

        # Send filler phrase only if no text was already streamed.
        if not text_tokens:
            yield {"type": "filler", "token": _FILLER}

        # Build the assistant message that contains the tool call request.
        tool_calls_list: list[dict] = []
        for i in sorted(tool_calls_acc.keys()):
            tc = tool_calls_acc[i]
            tool_calls_list.append({
                "id": tc["id"],
                "type": "function",
                "function": {"name": tc["name"], "arguments": tc["args"]},
            })

        session.history.append({
            "role": "assistant",
            "content": turn_text or None,
            "tool_calls": tool_calls_list,
        })

        # Execute all tool calls concurrently.
        async def _exec(tc: dict) -> tuple[str, str]:
            try:
                raw_args = tc["function"]["arguments"] or "{}"
                args = json.loads(raw_args)
            except json.JSONDecodeError:
                args = {}
            result = await tool_registry.dispatch(
                tc["function"]["name"], args, session
            )
            return tc["id"], result

        try:
            pairs = await asyncio.gather(
                *[_exec(tc) for tc in tool_calls_list],
                return_exceptions=False,
            )
        except asyncio.CancelledError:
            logger.info("Tool execution cancelled")
            return

        for call_id, result_str in pairs:
            session.history.append({
                "role": "tool",
                "tool_call_id": call_id,
                "content": result_str,
            })

        # Loop back to call the LLM again with tool results.

    # Safety cap hit — end gracefully.
    logger.warning("Agent turn hit max tool iterations (%d)", _MAX_TOOL_ITERATIONS)
    yield {
        "type": "text_token",
        "token": "I've looked into that for you. Let me know if you need anything else.",
    }
    yield {"type": "turn_done"}
