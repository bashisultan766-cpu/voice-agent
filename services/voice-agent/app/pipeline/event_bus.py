"""
Minimal asyncio event bus: fire-and-forget pub/sub for in-process events.

No external deps. Handlers are spawned as Tasks so they never block the emitter.
"""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

Handler = Callable[..., Awaitable[None]]


class EventBus:
    """
    Lightweight pub/sub bus.

    emit() spawns each handler as an asyncio.Task — caller is never blocked.
    Handler exceptions are logged and swallowed so one bad handler can't
    bring down the pipeline.

    Events used by the streaming pipeline:
        partial_transcript_updated(text, confidence)
        utterance_ended(text)
        barge_in()
    """

    def __init__(self) -> None:
        self._handlers: dict[str, list[Handler]] = defaultdict(list)

    def on(self, event: str, handler: Handler) -> None:
        """Register a coroutine handler for an event."""
        self._handlers[event].append(handler)

    async def emit(self, event: str, **payload: Any) -> None:
        """
        Dispatch event to all registered handlers as background tasks.
        Returns immediately; handlers run on the next event-loop iteration.
        """
        for handler in self._handlers.get(event, []):
            asyncio.create_task(
                self._safe_call(handler, payload),
                name=f"bus:{event}:{handler.__name__}",
            )

    @staticmethod
    async def _safe_call(handler: Handler, payload: dict) -> None:
        try:
            await handler(**payload)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.error("EventBus handler %s raised: %s", handler.__name__, exc)
