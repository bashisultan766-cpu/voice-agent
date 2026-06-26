"""
Parallel tool executor for the pipeline prefetch layer.

Runs speculative tool calls concurrently and stores results in the session's
prefetch_cache dict. The registry dispatch checks the prefetch cache first so
live Shopify calls are served from cache when the LLM eventually requests them.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass
from typing import Optional

from ..state.models import SessionState
from ..tools import registry as tool_registry

logger = logging.getLogger(__name__)


@dataclass
class ToolResult:
    name: str
    result: Optional[str]
    success: bool
    latency_ms: float
    error: Optional[str] = None


def prefetch_key(tool_name: str, args: dict) -> str:
    """
    Stable, deterministic cache key for a (tool_name, args) pair.

    Excludes the 'session' key from hashing since it's always injected
    by the registry and varies across calls.
    """
    clean = {k: v for k, v in args.items() if k != "session"}
    payload = json.dumps(clean, sort_keys=True)
    digest = hashlib.sha256(payload.encode()).hexdigest()[:12]
    return f"{tool_name}:{digest}"


async def run_tools_parallel(
    tool_calls: list[dict],
    session: SessionState,
    timeout_ms: int = 2500,
) -> list[ToolResult]:
    """
    Execute tool calls concurrently with a per-tool timeout.

    Each entry: {"name": str, "args": dict}

    Successful results are stored in session.prefetch_cache so registry.dispatch
    can return them on cache hit (avoids duplicate Shopify round-trips).

    Never raises — individual failures produce ToolResult(success=False).
    """
    timeout_secs = timeout_ms / 1000

    async def _run_one(tc: dict) -> ToolResult:
        name = tc["name"]
        args = tc.get("args", {})
        t0 = time.monotonic()
        try:
            result = await asyncio.wait_for(
                tool_registry.dispatch(name, args, session),
                timeout=timeout_secs,
            )
            elapsed = (time.monotonic() - t0) * 1000
            key = prefetch_key(name, args)
            session.prefetch_cache[key] = result
            logger.debug("Prefetch ok tool=%s %.0fms", name, elapsed)
            return ToolResult(name=name, result=result, success=True, latency_ms=elapsed)
        except asyncio.TimeoutError:
            elapsed = (time.monotonic() - t0) * 1000
            logger.warning("Prefetch tool=%s timed out (%.0fms)", name, elapsed)
            return ToolResult(
                name=name, result=None, success=False, latency_ms=elapsed, error="timeout"
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            elapsed = (time.monotonic() - t0) * 1000
            logger.warning("Prefetch tool=%s error: %s", name, exc)
            return ToolResult(
                name=name, result=None, success=False, latency_ms=elapsed, error=str(exc)
            )

    if not tool_calls:
        return []

    results = await asyncio.gather(*[_run_one(tc) for tc in tool_calls])
    return list(results)
