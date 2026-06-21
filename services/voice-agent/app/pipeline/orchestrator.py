"""
StreamingOrchestrator: real-time voice pipeline coordinator.

Incremental flow (on every STT partial):
    partial text → entity extraction → speculative tool call (background, non-blocking)

Finalization flow (on utterance_end):
    collect cached speculative results → inject into LLM context → stream sentences → TTS

Barge-in:
    speech_started event → cancel response task → clear Twilio audio queue

Design rules:
  - on_stt_event() is the SINGLE entry point from the WebSocket layer.
  - utterance_end (speech_final) is the ONLY turn-end trigger. No double-endpointing.
  - EventBus handlers fire as background tasks — never block the STT recv loop.
  - Speculative results land in ResultCache shared with the LLM executor.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any

from openai import AsyncOpenAI

from ..core.config import Settings
from ..state.schema import SessionState
from ..tenant.schema import AgentConfig
from ..ai.prompt_builder import build_system_prompt
from ..tools import registry as tool_registry
from ..tools.base import ToolContext
from .audio import chunk_for_twilio
from .event_bus import EventBus
from .intent import Entity, extract_entities
from .llm import StreamingLLM
from .realtime_loop import RealtimeLoop
from .task_manager import ResultCache, TaskManager
from .tts import OpenAIStreamingTTS
from .stt import STTEvent

logger = logging.getLogger(__name__)

_FILLER_TIMEOUT_S = 0.40       # inject filler if no first sentence within 400ms
_FILLER_TEXT = "Let me check on that for you."
_CACHE_TTL_S = 60.0            # speculative result TTL


def _tool_cache_key(tool_name: str, args: dict) -> str:
    """Canonical cache key shared by speculative executor and LLM executor."""
    return f"{tool_name}:{json.dumps(args, sort_keys=True)[:80]}"


class StreamingOrchestrator:
    """
    One instance per active call. Owns the full voice pipeline.

    External interface:
        on_stt_event(event)   — called by WS handler for every STT event
        greet()               — send opening greeting on call start
        is_speaking           — True while AI audio is playing (barge-in guard)
    """

    def __init__(
        self,
        send_q: asyncio.Queue,
        stream_sid: str,
        session: SessionState,
        agent_config: AgentConfig,
        openai_client: AsyncOpenAI,
        settings: Settings,
    ) -> None:
        self._q = send_q
        self._stream_sid = stream_sid
        self._session = session
        self._agent_config = agent_config
        self._settings = settings

        self._llm = StreamingLLM(
            openai_client,
            model=agent_config.openai_model or settings.effective_llm_model,
            max_tokens=settings.LLM_MAX_TOKENS_PER_TURN,
        )
        self._tts = OpenAIStreamingTTS(
            openai_client,
            model=settings.OPENAI_TTS_MODEL,
            voice=agent_config.voice_id or settings.OPENAI_TTS_VOICE,
        )

        # Speculative execution state — reset each utterance
        self._tasks = TaskManager()
        self._cache = ResultCache(ttl=_CACHE_TTL_S)

        # Pending final-transcript accumulation (for multi-segment utterances)
        self._pending_text = ""

        # Response lifecycle
        self._response_task: asyncio.Task | None = None
        self._is_speaking = False

        # EventBus wires incremental → speculative → finalization
        self._bus = EventBus()
        self._bus.on("partial_transcript_updated", self._on_partial)
        self._bus.on("utterance_ended", self._on_utterance_end)
        self._bus.on("barge_in", self._on_barge_in)

        # 150ms incremental loop — shares _tasks and _cache with this orchestrator
        self._realtime_loop = RealtimeLoop(self._bus, self._tasks, self._cache)

    @property
    def is_speaking(self) -> bool:
        return self._is_speaking

    # ── STT event router ───────────────────────────────────────────────────────

    async def on_stt_event(self, event: STTEvent) -> None:
        """
        Route every Deepgram event to the appropriate pipeline stage.

        Call from the WebSocket recv loop — executes synchronously (no blocking I/O).
        EventBus.emit() spawns handlers as Tasks so this returns immediately.

        Turn-end rule: speech_final=True is the ONLY trigger for utterance_ended.
        UtteranceEnd (speech_final=True, text="") also satisfies this.
        """
        if event.speech_started:
            # Deepgram VAD: caller started speaking while AI may be speaking
            await self._bus.emit("barge_in")
            return

        if event.speech_final:
            # Combine accumulated segments with the final segment text
            text = (self._pending_text + " " + event.text).strip()
            self._pending_text = ""
            if text:
                await self._bus.emit("utterance_ended", text=text)
            return

        if event.is_final and event.text:
            # Mid-utterance finalized segment — accumulate, don't trigger yet
            self._pending_text = (self._pending_text + " " + event.text).strip()
            return

        if not event.is_final and event.text:
            # Partial interim transcript → incremental processing
            await self._bus.emit(
                "partial_transcript_updated",
                text=event.text,
                confidence=event.confidence,
            )

    # ── EventBus handlers ──────────────────────────────────────────────────────

    async def _on_partial(self, text: str, confidence: float) -> None:
        """
        Incremental stage: extract entities from partial text, fire speculative tools.
        Must be fast — runs on every interim STT result.
        """
        for entity in extract_entities(text):
            await self._fire_speculative(entity)

    async def _on_utterance_end(self, text: str) -> None:
        """
        Turn finalization: cancel stale response, harvest cache, run LLM pipeline.
        """
        # Cancel any in-progress response (previous turn still running)
        if self._response_task and not self._response_task.done():
            await self._interrupt_response()

        # Collect speculative results that arrived before LLM starts
        pre_fetched = self._cache.items()

        # Cancel remaining speculative tasks (no longer needed this turn)
        self._tasks.cancel_all()

        self._response_task = asyncio.create_task(
            self._respond(text, pre_fetched),
            name=f"respond:{text[:24]}",
        )

    async def _on_barge_in(self) -> None:
        """Caller started speaking — stop AI output immediately."""
        if self._is_speaking:
            await self._interrupt_response()
        # Reset speculative state for the incoming new utterance
        self._tasks.cancel_all()
        self._pending_text = ""

    # ── Speculative execution ──────────────────────────────────────────────────

    async def _fire_speculative(self, entity: Entity) -> None:
        """
        Non-blocking: launch background tool call if not cached or already running.
        Low-confidence entities (title_query < 0.65) are suppressed to avoid noise.
        """
        if entity.type == "isbn":
            args: dict[str, Any] = {"isbn": entity.value}
            tool_name = "search_catalog"
        elif entity.type == "order_number":
            args = {"order_number": entity.value}
            tool_name = "get_order"
        elif entity.type == "title_query" and entity.confidence >= 0.65:
            args = {"query": entity.value}
            tool_name = "search_catalog"
        else:
            return

        key = _tool_cache_key(tool_name, args)
        if self._cache.has(key):
            return  # already have a fresh result

        self._tasks.submit(key, self._run_speculative(tool_name, args, key))

    async def _run_speculative(
        self, tool_name: str, args: dict, cache_key: str
    ) -> None:
        """Execute tool and store voice_summary in cache. Never raises."""
        tool = tool_registry.get(tool_name)
        if tool is None:
            return
        ctx = self._tool_context()
        try:
            result = await tool.execute(args, ctx)
            value = result.voice_summary or json.dumps(result.data)
            if value:
                self._cache.set(cache_key, value)
                logger.debug("Speculative %s cached (key=%s)", tool_name, cache_key)
        except Exception as exc:
            logger.debug("Speculative %s failed: %s", tool_name, exc)

    # ── Main response pipeline ─────────────────────────────────────────────────

    async def _respond(self, user_text: str, pre_fetched: dict) -> None:
        self._is_speaking = True
        producer_task: asyncio.Task | None = None
        collected: list[str] = []

        try:
            messages = self._build_messages(user_text, pre_fetched)
            tools = tool_registry.get_schemas(self._agent_config.enabled_tools)
            executor = self._tool_executor()

            sentence_q: asyncio.Queue[str | None] = asyncio.Queue()

            async def produce() -> None:
                try:
                    async for sentence in self._llm.stream_sentences(
                        messages, tools, executor
                    ):
                        await sentence_q.put(sentence)
                except asyncio.CancelledError:
                    pass
                except Exception as exc:
                    logger.error("LLM stream error: %s", exc)
                finally:
                    await sentence_q.put(None)

            producer_task = asyncio.create_task(produce(), name="llm-producer")

            # First sentence: inject filler if LLM is slow (tool round-trip)
            try:
                first = await asyncio.wait_for(
                    sentence_q.get(), timeout=_FILLER_TIMEOUT_S
                )
            except asyncio.TimeoutError:
                await self._synthesize_and_send(_FILLER_TEXT)
                first = await sentence_q.get()

            if first is not None:
                await self._synthesize_and_send(first)
                collected.append(first)

            while True:
                sentence = await sentence_q.get()
                if sentence is None:
                    break
                await self._synthesize_and_send(sentence)
                collected.append(sentence)

            if collected:
                self._session.add_turn(user_text, " ".join(collected))

        except asyncio.CancelledError:
            logger.debug("Response cancelled: %r", user_text[:30])
            raise
        except Exception:
            logger.exception("Response pipeline error")
        finally:
            if producer_task and not producer_task.done():
                producer_task.cancel()
                await asyncio.gather(producer_task, return_exceptions=True)
            self._is_speaking = False

    async def _interrupt_response(self) -> None:
        """Cancel active response and clear Twilio audio queue."""
        self._llm.cancel()
        if self._response_task and not self._response_task.done():
            self._response_task.cancel()
            try:
                await self._response_task
            except (asyncio.CancelledError, Exception):
                pass
        self._is_speaking = False
        await self._send_clear()

    # ── Greeting ───────────────────────────────────────────────────────────────

    async def greet(self) -> None:
        """Synthesize and play the agent greeting. Cancellable on barge-in."""
        self._realtime_loop.start(self._tool_context())
        self._response_task = asyncio.create_task(
            self._do_greet(), name="greeting"
        )

    async def close(self) -> None:
        """Release all per-call resources. Call from WebSocket cleanup."""
        await self._interrupt_response()
        await self._realtime_loop.stop()

    async def _do_greet(self) -> None:
        self._is_speaking = True
        try:
            mulaw = await self._tts.synthesize(self._agent_config.resolve_greeting())
            await self._send_audio(mulaw)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Greeting failed")
        finally:
            self._is_speaking = False

    # ── Audio I/O ──────────────────────────────────────────────────────────────

    async def _synthesize_and_send(self, text: str) -> None:
        """Stream TTS for one sentence fragment, sending 20ms frames to Twilio."""
        async for mulaw_chunk in self._tts.stream_mulaw(text):
            await self._send_audio(mulaw_chunk)

    async def _send_audio(self, mulaw_bytes: bytes) -> None:
        for frame in chunk_for_twilio(mulaw_bytes):
            await self._q.put(json.dumps({
                "event": "media",
                "streamSid": self._stream_sid,
                "media": {"payload": base64.b64encode(frame).decode()},
            }))

    async def _send_clear(self) -> None:
        await self._q.put(json.dumps({
            "event": "clear",
            "streamSid": self._stream_sid,
        }))

    # ── Context and tool helpers ───────────────────────────────────────────────

    def _build_messages(self, user_text: str, pre_fetched: dict) -> list[dict]:
        system_prompt = build_system_prompt(self._agent_config, self._session)

        if pre_fetched:
            # Inject pre-fetched results so LLM can answer without calling tools again
            block = "\n\nPRE-FETCHED CONTEXT (use directly — DO NOT call these tools again):\n"
            block += "\n".join(f"• {v}" for v in pre_fetched.values())
            system_prompt += block

        return [
            {"role": "system", "content": system_prompt},
            *self._session.to_openai_messages(),
            {"role": "user", "content": user_text},
        ]

    def _tool_context(self) -> ToolContext:
        return ToolContext(
            session_id=self._session.session_id,
            agent_id=self._session.agent_id,
            call_sid=self._session.call_sid,
            from_number=self._session.from_number,
            agent_config=self._agent_config,
            session_state=self._session,
        )

    def _tool_executor(self):
        """
        Returns an async callable for the LLM tool loop.
        Cache-first: if the speculative executor already ran this tool, return cached.
        """
        ctx = self._tool_context()

        async def executor(tool_name: str, args_json: str) -> str:
            try:
                args = json.loads(args_json)
            except Exception:
                args = {}

            # Cache hit — speculative result already available
            key = _tool_cache_key(tool_name, args)
            cached = self._cache.get(key)
            if cached:
                logger.debug("LLM tool %s → cache hit", tool_name)
                return cached

            # Cache miss — run tool normally
            tool = tool_registry.get(tool_name)
            if tool is None:
                return f"Tool '{tool_name}' not found"
            try:
                result = await tool.execute(args, ctx)
                if result.state_update:
                    for k, v in result.state_update.items():
                        if hasattr(self._session, k):
                            setattr(self._session, k, v)
                value = result.voice_summary or json.dumps(result.data)
                self._cache.set(key, value)
                return value
            except Exception as exc:
                logger.error("Tool %s error: %s", tool_name, exc)
                return "I had trouble with that. Please try again."

        return executor
