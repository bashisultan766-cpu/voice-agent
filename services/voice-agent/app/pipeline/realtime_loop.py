"""
RealtimeLoop: 150ms timer-based incremental processing of partial transcripts.

Sits alongside the event-driven path in StreamingOrchestrator to add:
  - Rate-limited processing (at most ~6.7 ticks/sec vs. every STT frame)
  - Dirty-flag buffer (skips ticks when transcript hasn't changed)
  - Stale task pruning on utterance_end (cancels tasks whose entities
    are absent from the final transcript)

Integration contract:
    loop = RealtimeLoop(bus, tasks, cache)
    loop.start(tool_ctx)         # call after STT starts
    await loop.stop()            # call on call end / cleanup

EventBus events consumed (read-only — orchestrator remains source of truth):
    partial_transcript_updated(text, confidence)
    utterance_ended(text)

TaskManager / ResultCache are shared with StreamingOrchestrator so speculative
results land in the same cache the LLM executor reads from.

Performance contract:
    _process_tick() — synchronous, <10ms budget, zero I/O
    _run_tool()     — async, runs as background Task via TaskManager
"""
from __future__ import annotations

import asyncio
import json
import logging

from ..tools import registry as tool_registry
from ..tools.base import ToolContext
from .event_bus import EventBus
from .intent import Entity, extract_entities
from .task_manager import ResultCache, TaskManager

logger = logging.getLogger(__name__)

_TICK_S = 0.150   # 150ms between ticks


# ── Helpers ────────────────────────────────────────────────────────────────────

def _tool_cache_key(tool_name: str, args: dict) -> str:
    """Must match the key format used by StreamingOrchestrator._tool_executor."""
    return f"{tool_name}:{json.dumps(args, sort_keys=True)[:80]}"


def _entity_to_tool(entity: Entity) -> tuple[str, dict] | tuple[None, None]:
    """Map a detected entity to (tool_name, args). Returns (None, None) to skip."""
    if entity.type == "isbn":
        return "search_catalog", {"isbn": entity.value}
    if entity.type == "order_number":
        return "get_order", {"order_number": entity.value}
    if entity.type == "title_query" and entity.confidence >= 0.65:
        return "search_catalog", {"query": entity.value}
    return None, None


# ── PartialTranscriptBuffer ───────────────────────────────────────────────────

class PartialTranscriptBuffer:
    """
    Holds the latest partial transcript for the current utterance.

    Dirty-flag pattern: update() marks dirty; consume() returns text only when
    it has changed since the last tick, then clears the flag.

    All methods are synchronous — safe to call from async context without locks
    (asyncio is single-threaded; no concurrent mutation possible).
    """

    __slots__ = ("_text", "_dirty")

    def __init__(self) -> None:
        self._text = ""
        self._dirty = False

    def update(self, text: str) -> None:
        """Called on every PartialTranscriptUpdated event."""
        if text and text != self._text:
            self._text = text
            self._dirty = True

    def consume(self) -> str | None:
        """Return current text if dirty; else None. Resets dirty flag."""
        if not self._dirty:
            return None
        self._dirty = False
        return self._text

    def clear(self) -> None:
        self._text = ""
        self._dirty = False


# ── RealtimeLoop ──────────────────────────────────────────────────────────────

class RealtimeLoop:
    """
    Per-call 150ms incremental execution engine.

    Responsibilities:
        A) Buffer partial transcripts (dirty-flag, no per-frame processing)
        B) Every 150ms: extract entities (regex, <5ms) → submit speculative tools
        C) On utterance_ended: prune speculative tasks not relevant to final text

    TaskManager.submit() is idempotent for the same key — running both this loop
    and the orchestrator's event-driven _on_partial path is safe; no double calls.
    """

    def __init__(
        self,
        bus: EventBus,
        tasks: TaskManager,
        cache: ResultCache,
    ) -> None:
        self._tasks = tasks
        self._cache = cache
        self._buffer = PartialTranscriptBuffer()
        self._ctx: ToolContext | None = None
        self._loop_task: asyncio.Task | None = None
        # Keys submitted in current utterance (for stale-pruning on utterance_end)
        self._utterance_keys: set[str] = set()

        bus.on("partial_transcript_updated", self._on_partial)
        bus.on("utterance_ended", self._on_utterance_end)

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    def start(self, ctx: ToolContext) -> None:
        """
        Start the 150ms tick loop. Call once after STT connection is established.
        Idempotent — safe to call if already running.
        """
        self._ctx = ctx
        if self._loop_task and not self._loop_task.done():
            return
        self._loop_task = asyncio.create_task(
            self._tick_loop(), name="realtime-loop"
        )
        logger.debug("RealtimeLoop started (tick=%dms)", int(_TICK_S * 1000))

    async def stop(self) -> None:
        """Cancel the tick loop. Call on call end."""
        if self._loop_task and not self._loop_task.done():
            self._loop_task.cancel()
            await asyncio.gather(self._loop_task, return_exceptions=True)
        logger.debug("RealtimeLoop stopped")

    # ── EventBus handlers ──────────────────────────────────────────────────────

    async def _on_partial(self, text: str, confidence: float) -> None:
        """Update buffer with the latest partial text. Sync — no I/O."""
        self._buffer.update(text)

    async def _on_utterance_end(self, text: str) -> None:
        """
        Prune speculative tasks whose detected entities are absent from the
        final transcript. Tasks matching final intent are left running so the
        LLM executor can find their results in ResultCache.
        """
        # Entities present in the final (complete) transcript
        final_values = {e.value.lower() for e in extract_entities(text)}

        for key in list(self._utterance_keys):
            # key = "tool_name:{...json args...}" — check if any final entity
            # value appears as a substring of the serialised args
            relevant = any(fv in key.lower() for fv in final_values)
            if not relevant:
                self._tasks.cancel(key)
                logger.debug("RealtimeLoop: pruned stale task key=%s", key)

        self._utterance_keys.clear()
        self._buffer.clear()

    # ── Tick loop ──────────────────────────────────────────────────────────────

    async def _tick_loop(self) -> None:
        """
        Core 150ms loop. Consumes buffer, runs _process_tick (sync <10ms budget).
        Errors are caught per-tick so one bad entity never kills the loop.
        """
        while True:
            await asyncio.sleep(_TICK_S)
            try:
                text = self._buffer.consume()
                if text:
                    self._process_tick(text)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.debug("RealtimeLoop tick error: %s", exc)

    def _process_tick(self, text: str) -> None:
        """
        Synchronous tick body — zero blocking I/O allowed.
        Budget: <10ms (regex extract + asyncio.create_task via TaskManager).

        Submits tool coroutines as background Tasks.
        TaskManager.submit() is dedup-safe: same key → returns existing Task.
        """
        for entity in extract_entities(text):
            tool_name, args = _entity_to_tool(entity)
            if tool_name is None:
                continue

            key = _tool_cache_key(tool_name, args)
            if self._cache.has(key):
                continue  # result already available — no task needed

            self._tasks.submit(key, self._run_tool(tool_name, args, key))
            self._utterance_keys.add(key)
            logger.debug(
                "RealtimeLoop: speculative %s queued (entity=%s conf=%.2f)",
                tool_name, entity.value, entity.confidence,
            )

    # ── Tool execution (background) ────────────────────────────────────────────

    async def _run_tool(self, tool_name: str, args: dict, cache_key: str) -> None:
        """
        Execute tool and store voice_summary in ResultCache.
        Runs as a background Task — never raises; errors are debug-logged.
        CancelledError is re-raised so TaskManager.cancel() works correctly.
        """
        if self._ctx is None:
            return
        tool = tool_registry.get(tool_name)
        if tool is None:
            logger.debug("RealtimeLoop: unknown tool %s", tool_name)
            return
        try:
            result = await tool.execute(args, self._ctx)
            value = result.voice_summary or json.dumps(result.data)
            if value:
                self._cache.set(cache_key, value)
                logger.debug(
                    "RealtimeLoop: cached %s key=%s len=%d",
                    tool_name, cache_key, len(value),
                )
        except asyncio.CancelledError:
            logger.debug("RealtimeLoop: %s cancelled (key=%s)", tool_name, cache_key)
            raise
        except Exception as exc:
            logger.debug("RealtimeLoop: %s failed: %s", tool_name, exc)
