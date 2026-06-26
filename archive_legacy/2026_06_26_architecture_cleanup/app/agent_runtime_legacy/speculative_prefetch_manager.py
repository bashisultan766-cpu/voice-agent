"""Speculative read-only prefetch manager (v4.16.0)."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from dataclasses import dataclass, field
from typing import Literal, TYPE_CHECKING

if TYPE_CHECKING:
    from .commerce_session import CommerceSession
    from .memory_packet import MemoryPacket

logger = logging.getLogger(__name__)

PrefetchKind = Literal[
    "conversation_signal",
    "catalog_candidate",
    "isbn_candidate",
    "publication_candidate",
    "order_candidate",
    "refund_candidate",
    "facility_candidate",
    "cart_state",
    "payment_readiness",
    "email_parse",
    "shipping_policy",
    "store_info",
    "out_of_domain_signal",
]


@dataclass
class PrefetchResult:
    result_id: str
    scout_name: str
    kind: PrefetchKind
    confidence: float
    entities: dict = field(default_factory=dict)
    facts: dict = field(default_factory=dict)
    source: str = ""
    safe_for_llm: bool = True
    requires_live_verification: bool = False


@dataclass
class PrefetchError:
    scout_name: str
    error: str


@dataclass
class SpeculativePrefetchPacket:
    prefetch_id: str
    user_text_hash: str
    started_at_ms: int
    completed_at_ms: int = 0
    results: list[PrefetchResult] = field(default_factory=list)
    errors: list[PrefetchError] = field(default_factory=list)
    stale: bool = False


class SpeculativePrefetchManager:
    """Run safe read-only scouts in parallel. Scouts never mutate state or answer callers."""

    SCOUT_MODULES = (
        "conversation_scout",
        "catalog_scout",
        "isbn_scout",
        "publication_scout",
        "order_scout",
        "refund_scout",
        "facility_scout",
        "cart_scout",
        "payment_readiness_scout",
        "email_scout",
        "domain_scout",
    )

    def __init__(self, settings=None) -> None:
        if settings is None:
            from ..config import get_settings
            settings = get_settings()
        self._settings = settings

    async def prefetch(
        self,
        *,
        call_sid: str,
        user_text: str,
        memory_packet: "MemoryPacket | None" = None,
        commerce_session: "CommerceSession | None" = None,
    ) -> SpeculativePrefetchPacket:
        if not getattr(self._settings, "VOICE_SPECULATIVE_PREFETCH_ENABLED", True):
            return SpeculativePrefetchPacket(
                prefetch_id="disabled",
                user_text_hash=_hash_text(user_text),
                started_at_ms=_now_ms(),
                completed_at_ms=_now_ms(),
            )

        sid = (call_sid or "")[:6]
        started = _now_ms()
        text_hash = _hash_text(user_text)
        prefetch_id = f"{sid}-{text_hash[:8]}"
        logger.info("speculative_prefetch_started sid=%s prefetch_id=%s", sid, prefetch_id)

        timeout_ms = getattr(self._settings, "VOICE_PREFETCH_SCOUT_TIMEOUT_MS", 1500)
        ctx = {
            "call_sid": call_sid,
            "user_text": user_text,
            "memory_packet": memory_packet,
            "commerce_session": commerce_session,
            "settings": self._settings,
        }

        tasks = [self._run_scout(name, ctx) for name in self.SCOUT_MODULES]
        results: list[PrefetchResult] = []
        errors: list[PrefetchError] = []

        try:
            done, pending = await asyncio.wait(
                [asyncio.create_task(t) for t in tasks],
                timeout=timeout_ms / 1000,
            )
            for task in pending:
                task.cancel()
            for task in done:
                try:
                    scout_result = task.result()
                    if scout_result is None:
                        continue
                    if isinstance(scout_result, PrefetchResult):
                        results.append(scout_result)
                        logger.info(
                            "prefetch_result_ready scout=%s kind=%s confidence=%.2f",
                            scout_result.scout_name,
                            scout_result.kind,
                            scout_result.confidence,
                        )
                except Exception as exc:
                    errors.append(PrefetchError(scout_name="unknown", error=str(exc)[:80]))
        except Exception as exc:
            errors.append(PrefetchError(scout_name="manager", error=str(exc)[:80]))

        completed = _now_ms()
        ms = completed - started
        logger.info(
            "speculative_prefetch_completed sid=%s results=%d errors=%d ms=%d",
            sid, len(results), len(errors), ms,
        )
        return SpeculativePrefetchPacket(
            prefetch_id=prefetch_id,
            user_text_hash=text_hash,
            started_at_ms=started,
            completed_at_ms=completed,
            results=results,
            errors=errors,
        )

    async def _run_scout(self, module_name: str, ctx: dict):
        from importlib import import_module
        mod = import_module(f"app.agent_runtime.scouts.{module_name}")
        scout_fn = getattr(mod, "run_scout", None)
        if scout_fn is None:
            return None
        return await scout_fn(**ctx)


def _hash_text(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def _now_ms() -> int:
    return int(time.time() * 1000)


async def start_prefetch_parallel(
    manager: SpeculativePrefetchManager,
    *,
    call_sid: str,
    user_text: str,
    memory_packet: "MemoryPacket | None" = None,
    commerce_session: "CommerceSession | None" = None,
) -> asyncio.Task[SpeculativePrefetchPacket]:
    return asyncio.create_task(
        manager.prefetch(
            call_sid=call_sid,
            user_text=user_text,
            memory_packet=memory_packet,
            commerce_session=commerce_session,
        )
    )


async def wait_for_prefetch(
    task: asyncio.Task[SpeculativePrefetchPacket] | None,
    max_wait_ms: int,
) -> SpeculativePrefetchPacket | None:
    if task is None:
        return None
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout=max_wait_ms / 1000)
    except asyncio.TimeoutError:
        return None
