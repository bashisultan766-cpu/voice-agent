"""
Streaming OpenAI LLM: yields complete sentences from a token stream.

Handles tool calls transparently:
  round 1 → detect tool_call deltas → accumulate args → execute in parallel
  round 2 → stream final text-only response → yield sentences

Sentence boundary detection (voice-optimised):
  Split on ". ", "! ", "? " (punctuation followed by space).
  Force-yield at _MAX_BUFFER_CHARS to avoid silence on very long sentences.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, AsyncIterator, Awaitable, Callable

from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

_SENTENCE_END = re.compile(r'(?<=[.!?])\s')
_MAX_BUFFER_CHARS = 180   # force-yield threshold (no boundary found yet)

ToolExecutor = Callable[[str, str], Awaitable[str]]


class StreamingLLM:
    """
    Wraps OpenAI streaming chat completions for voice.

    cancel()         — signal barge-in; stops token consumption on next chunk.
    stream_sentences() — async generator: yields one sentence at a time.
    """

    def __init__(
        self,
        client: AsyncOpenAI,
        model: str = "gpt-4o-mini",
        max_tokens: int = 250,
    ) -> None:
        self._client = client
        self._model = model
        self._max_tokens = max_tokens
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    def reset(self) -> None:
        self._cancelled = False

    async def stream_sentences(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        tool_executor: ToolExecutor | None = None,
    ) -> AsyncIterator[str]:
        """
        Yield one sentence at a time.
        Tool calls (up to 3 rounds) are resolved transparently before text yields.
        Caller sees only text sentences regardless of tool use.
        """
        self._cancelled = False
        msgs = list(messages)

        for _round in range(3):
            if self._cancelled:
                return

            kwargs: dict[str, Any] = {
                "model": self._model,
                "messages": msgs,
                "max_tokens": self._max_tokens,
                "temperature": 0.7,
                "stream": True,
            }
            if tools:
                kwargs["tools"] = tools
                kwargs["tool_choice"] = "auto"

            buffer = ""
            tc_acc: list[dict] = []   # accumulated tool call deltas

            stream = await self._client.chat.completions.create(**kwargs)
            async for chunk in stream:
                if self._cancelled:
                    return

                delta = chunk.choices[0].delta

                # Accumulate tool call argument deltas
                if delta.tool_calls:
                    for tcd in delta.tool_calls:
                        while len(tc_acc) <= tcd.index:
                            tc_acc.append({"id": "", "name": "", "arguments": ""})
                        if tcd.id:
                            tc_acc[tcd.index]["id"] = tcd.id
                        if tcd.function and tcd.function.name:
                            tc_acc[tcd.index]["name"] = tcd.function.name
                        if tcd.function and tcd.function.arguments:
                            tc_acc[tcd.index]["arguments"] += tcd.function.arguments
                    continue  # no text delta while tool calls accumulating

                if not delta.content:
                    continue

                buffer += delta.content

                # Yield complete sentences as boundaries arrive
                while True:
                    m = _SENTENCE_END.search(buffer)
                    if not m:
                        break
                    sentence = buffer[: m.start() + 1].strip()
                    buffer = buffer[m.end() :]
                    if sentence:
                        yield sentence

                # Force-yield on very long buffers (run-on sentences)
                if len(buffer) >= _MAX_BUFFER_CHARS:
                    yield buffer.strip()
                    buffer = ""

            # Yield any remaining text after stream closes
            if buffer.strip() and not self._cancelled:
                yield buffer.strip()

            # Pure text response — done
            if not tc_acc:
                return

            if tool_executor is None:
                logger.warning("LLM requested tools but no executor provided")
                return

            # Append assistant message with accumulated tool calls
            msgs.append({
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {"name": tc["name"], "arguments": tc["arguments"]},
                    }
                    for tc in tc_acc
                ],
            })

            # Execute all tool calls in parallel
            results = await asyncio.gather(
                *[tool_executor(tc["name"], tc["arguments"]) for tc in tc_acc],
                return_exceptions=True,
            )

            for tc, result in zip(tc_acc, results):
                content = (
                    str(result)
                    if not isinstance(result, Exception)
                    else "Tool error — please try again."
                )
                msgs.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": content,
                })

            tc_acc = []
            # Loop back → next round streams the text response
