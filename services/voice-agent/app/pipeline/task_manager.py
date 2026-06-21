"""
TaskManager: deduplicating async task registry for speculative tool execution.
ResultCache: per-call TTL cache shared between speculative and LLM executor paths.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)


class ResultCache:
    """
    In-memory TTL cache for tool results. One instance per call; never shared.

    Key contract:  f"{tool_name}:{canonical_args_str}"
    Value:         voice_summary string (what the LLM / system prompt injects)
    """

    def __init__(self, ttl: float = 60.0) -> None:
        self._store: dict[str, tuple[Any, float]] = {}
        self._ttl = ttl

    def get(self, key: str) -> str | None:
        entry = self._store.get(key)
        if entry and (time.monotonic() - entry[1]) < self._ttl:
            return entry[0]
        return None

    def set(self, key: str, value: str) -> None:
        self._store[key] = (value, time.monotonic())

    def has(self, key: str) -> bool:
        return self.get(key) is not None

    def items(self) -> dict[str, str]:
        """Return all non-expired entries as {key: value}."""
        now = time.monotonic()
        return {
            k: v
            for k, (v, ts) in self._store.items()
            if v and (now - ts) < self._ttl
        }


class TaskManager:
    """
    Deduplicating async task registry.

    submit(key, coro) — if key already running, returns the existing Task (dedup).
    cancel(key)       — cancel one task by key.
    cancel_all()      — cancel and clear everything (call on barge-in / new utterance).
    await_result()    — wait for a task result with timeout; returns None on miss.
    """

    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task] = {}

    def submit(self, key: str, coro: Any) -> asyncio.Task:
        """Start coro as a task under key. Returns existing task if key already running."""
        existing = self._tasks.get(key)
        if existing and not existing.done():
            logger.debug("TaskManager: dedup hit for key=%s", key)
            return existing
        task = asyncio.create_task(coro, name=f"spec:{key}")
        self._tasks[key] = task
        return task

    def get(self, key: str) -> asyncio.Task | None:
        return self._tasks.get(key)

    def cancel(self, key: str) -> None:
        task = self._tasks.pop(key, None)
        if task and not task.done():
            task.cancel()

    def cancel_all(self) -> None:
        """Cancel every tracked task. Call on barge-in or utterance reset."""
        for task in self._tasks.values():
            if not task.done():
                task.cancel()
        self._tasks.clear()

    async def await_result(self, key: str, timeout: float = 6.0) -> Any | None:
        """
        Await a running task's result with timeout.
        Uses asyncio.shield so the underlying task keeps running even on timeout.
        Returns None on timeout, cancellation, or exception.
        """
        task = self._tasks.get(key)
        if task is None:
            return None
        try:
            return await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
        except Exception:
            return None
