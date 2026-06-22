"""
Session store with Redis primary and in-memory fallback.

Also provides a generic cache helper used for Shopify product search results.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

# In-memory fallback (single-process only).
_store: dict[str, str] = {}
_lock = asyncio.Lock()

# Singleton Redis client — initialised lazily on first use.
_redis: Any = None
_redis_checked = False


async def _get_redis() -> Any:
    global _redis, _redis_checked
    if _redis_checked:
        return _redis
    _redis_checked = True
    try:
        from redis.asyncio import Redis
        from ..config import get_settings

        url = get_settings().REDIS_URL
        if not url:
            return None
        client = Redis.from_url(url, decode_responses=True, socket_connect_timeout=2)
        await client.ping()
        _redis = client
        logger.info("Redis session store connected: %s", url.split("@")[-1])
    except Exception as exc:
        logger.warning("Redis unavailable, using in-memory store: %s", exc)
        _redis = None
    return _redis


# ── Raw key/value helpers ──────────────────────────────────────────────────────

async def cache_set(key: str, value: Any, ttl: int = 3600) -> None:
    serialised = json.dumps(value)
    redis = await _get_redis()
    if redis:
        try:
            await redis.setex(key, ttl, serialised)
            return
        except Exception as exc:
            logger.warning("Redis set failed (%s): %s", key, exc)
    async with _lock:
        _store[key] = serialised


async def cache_get(key: str) -> Optional[Any]:
    redis = await _get_redis()
    if redis:
        try:
            raw = await redis.get(key)
            return json.loads(raw) if raw else None
        except Exception as exc:
            logger.warning("Redis get failed (%s): %s", key, exc)
    async with _lock:
        raw = _store.get(key)
    return json.loads(raw) if raw else None


async def cache_delete(key: str) -> None:
    redis = await _get_redis()
    if redis:
        try:
            await redis.delete(key)
        except Exception:
            pass
    async with _lock:
        _store.pop(key, None)


# ── Session helpers (thin wrappers with namespaced keys) ─────────────────────

async def save_session(session_id: str, data: dict, ttl: int = 7200) -> None:
    await cache_set(f"session:{session_id}", data, ttl)


async def load_session(session_id: str) -> Optional[dict]:
    return await cache_get(f"session:{session_id}")


async def delete_session(session_id: str) -> None:
    await cache_delete(f"session:{session_id}")


# ── Call resume snapshot by caller phone (v4.8) ───────────────────────────────

def _resume_phone_key(phone: str) -> str:
    digits = "".join(c for c in (phone or "") if c.isdigit())
    return f"call_resume:{digits[-10:] if len(digits) >= 10 else digits}"


async def save_call_resume_by_phone(phone: str, data: dict, ttl: int = 7200) -> None:
    """Persist a safe resume snapshot keyed by caller phone (last 10 digits)."""
    if not phone or phone == "unknown":
        return
    await cache_set(_resume_phone_key(phone), data, ttl=ttl)


async def load_call_resume_by_phone(phone: str) -> Optional[dict]:
    """Load the most recent resume snapshot for a caller phone."""
    if not phone or phone == "unknown":
        return None
    return await cache_get(_resume_phone_key(phone))


# ── Shopify product search cache ──────────────────────────────────────────────

async def shopify_cache_get(key: str) -> Optional[Any]:
    return await cache_get(f"shopify:{key}")


async def shopify_cache_set(key: str, value: Any, ttl: int = 60) -> None:
    await cache_set(f"shopify:{key}", value, ttl)
