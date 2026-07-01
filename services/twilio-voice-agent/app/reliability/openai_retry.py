"""
OpenAI completion retry policy — one retry on transient failures only.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

_TRANSIENT_STATUS = {408, 429, 500, 502, 503, 504}


def _is_transient(exc: BaseException) -> bool:
    name = type(exc).__name__.lower()
    if "timeout" in name or "ratelimit" in name or "rate_limit" in name:
        return True
    if "connection" in name or "server" in name:
        return True
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    if status in _TRANSIENT_STATUS:
        return True
    body = str(exc).lower()
    if any(tok in body for tok in ("timeout", "rate limit", "overloaded", "503", "502")):
        return True
    return False


def _is_invalid_request(exc: BaseException) -> bool:
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    if status in {400, 401, 403, 404, 422}:
        return True
    name = type(exc).__name__.lower()
    return "invalid" in name or "authentication" in name or "permission" in name


async def call_with_retry(
    fn: Callable[[], Awaitable[T]],
    *,
    purpose: str = "openai",
    max_attempts: int = 2,
) -> T:
    """Run ``fn`` with exponential backoff on transient errors."""
    from ..observability.otel import span

    last_exc: BaseException | None = None
    with span("openai_request", purpose=purpose):
        for attempt in range(max_attempts):
            try:
                return await fn()
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if _is_invalid_request(exc):
                    raise
                if attempt + 1 >= max_attempts or not _is_transient(exc):
                    raise
                wait = 0.3 * (2 ** attempt)
                logger.warning(
                    "openai_retry purpose=%s attempt=%d wait=%.1fs err=%s",
                    purpose,
                    attempt + 1,
                    wait,
                    type(exc).__name__,
                )
                await asyncio.sleep(wait)
    assert last_exc is not None
    raise last_exc
