"""
Request rate limiting — Redis-backed in production, in-memory in dev/test.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from typing import Callable

from fastapi import HTTPException, Request

from ..config import get_settings

logger = logging.getLogger(__name__)

_MEMORY_BUCKETS: dict[str, list[float]] = defaultdict(list)
_MEMORY_LOCK = asyncio.Lock()


def _client_key(request: Request, bucket: str) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "unknown")
    return f"{bucket}:{ip}"


async def _memory_check(key: str, limit: int, window_sec: int) -> bool:
    now = time.monotonic()
    cutoff = now - window_sec
    async with _MEMORY_LOCK:
        hits = [t for t in _MEMORY_BUCKETS[key] if t >= cutoff]
        if len(hits) >= limit:
            _MEMORY_BUCKETS[key] = hits
            return False
        hits.append(now)
        _MEMORY_BUCKETS[key] = hits
        return True


async def _redis_check(key: str, limit: int, window_sec: int) -> bool:
    try:
        from ..state.session_store import get_redis_client

        client = await get_redis_client()
        if client is None:
            return await _memory_check(key, limit, window_sec)

        pipe = client.pipeline()
        pipe.incr(key)
        pipe.expire(key, window_sec)
        count, _ = await pipe.execute()
        return int(count) <= limit
    except Exception as exc:
        logger.warning("rate_limit_redis_fallback key=%s err=%s", key[:32], type(exc).__name__)
        return await _memory_check(key, limit, window_sec)


async def check_rate_limit(key: str, *, limit: int, window_sec: int) -> bool:
    settings = get_settings()
    if settings.is_production:
        return await _redis_check(key, limit, window_sec)
    return await _memory_check(key, limit, window_sec)


def rate_limit_dependency(
    bucket: str,
    *,
    limit: int = 60,
    window_sec: int = 60,
) -> Callable:
    """FastAPI dependency that raises 429 when the limit is exceeded."""

    async def _dep(request: Request) -> None:
        key = _client_key(request, bucket)
        allowed = await check_rate_limit(key, limit=limit, window_sec=window_sec)
        if not allowed:
            logger.warning("rate_limit_exceeded bucket=%s", bucket)
            raise HTTPException(status_code=429, detail="Too many requests")

    return _dep
