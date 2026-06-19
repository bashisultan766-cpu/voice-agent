from __future__ import annotations
import json
from typing import Any, Optional
import redis.asyncio as aioredis
from app.config import settings

_pool: Optional[aioredis.Redis] = None  # type: ignore[assignment]


def get_redis() -> aioredis.Redis:
    global _pool
    if _pool is None:
        _pool = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    return _pool


async def cache_get(key: str) -> Optional[Any]:
    try:
        raw = await get_redis().get(key)
        return json.loads(raw) if raw is not None else None
    except Exception:
        return None


async def cache_set(key: str, value: Any, ttl: int = 60) -> None:
    try:
        await get_redis().setex(key, ttl, json.dumps(value, default=str))
    except Exception:
        pass


async def cache_delete(key: str) -> None:
    try:
        await get_redis().delete(key)
    except Exception:
        pass


async def cache_get_list(key: str) -> Optional[list]:
    return await cache_get(key)


async def cache_set_list(key: str, value: list, ttl: int = 60) -> None:
    await cache_set(key, value, ttl)
