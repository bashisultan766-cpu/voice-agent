"""
Async Postgres connection pool — optional unless DATABASE_URL is set.

Schema is applied on first connect. STRICT_POSTGRES=true fails fast when DB is
unavailable at startup or on write errors.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_pool: Any = None
_test_pool_override: Any = None
_schema_applied: bool = False

_SCHEMA_DIR = Path(__file__).resolve().parent / "migrations"
_SCHEMA_FILES = sorted(_SCHEMA_DIR.glob("*.sql"))


def set_test_pool(pool: Any) -> None:
    """Test hook — inject a fake pool without a live Postgres server."""
    global _test_pool_override, _schema_applied
    _test_pool_override = pool
    _schema_applied = True


def clear_test_pool() -> None:
    global _test_pool_override, _pool, _schema_applied
    _test_pool_override = None
    _pool = None
    _schema_applied = False


def db_configured() -> bool:
    from ..config import get_settings

    return bool((get_settings().DATABASE_URL or "").strip())


async def get_pool() -> Any:
    global _pool
    if _test_pool_override is not None:
        return _test_pool_override
    if _pool is not None:
        return _pool
    if not db_configured():
        return None

    import asyncpg

    from ..config import get_settings

    settings = get_settings()
    _pool = await asyncpg.create_pool(
        settings.DATABASE_URL,
        min_size=1,
        max_size=5,
        command_timeout=10,
    )
    await ensure_schema(_pool)
    return _pool


async def close_pool() -> None:
    global _pool, _schema_applied
    if _pool is not None:
        await _pool.close()
        _pool = None
    _schema_applied = False


async def ensure_schema(pool: Optional[Any] = None) -> None:
    global _schema_applied
    if _schema_applied:
        return
    p = pool or await get_pool()
    if p is None:
        return
    sql_parts = [p.read_text(encoding="utf-8") for p in _SCHEMA_FILES]
    sql = "\n".join(sql_parts)
    async with p.acquire() as conn:
        await conn.execute(sql)
    _schema_applied = True
    logger.info("postgres_schema_applied files=%d", len(_SCHEMA_FILES))


async def verify_postgres_at_startup() -> None:
    """Fail fast when STRICT_POSTGRES is enabled and DB is missing or unreachable."""
    from ..config import get_settings

    settings = get_settings()
    if not settings.STRICT_POSTGRES:
        return
    if not db_configured():
        raise RuntimeError("STRICT_POSTGRES=true requires DATABASE_URL to be set")
    pool = await get_pool()
    if pool is None:
        raise RuntimeError("STRICT_POSTGRES=true but Postgres pool could not be created")
    async with pool.acquire() as conn:
        await conn.fetchval("SELECT 1")


async def execute_write(query: str, *args: Any) -> None:
    """Run a write query; honor STRICT_POSTGRES on failure."""
    from ..config import get_settings

    settings = get_settings()
    if not db_configured():
        return
    try:
        pool = await get_pool()
        if pool is None:
            if settings.STRICT_POSTGRES:
                raise RuntimeError("Postgres pool unavailable")
            return
        async with pool.acquire() as conn:
            await conn.execute(query, *args)
    except Exception as exc:
        if settings.STRICT_POSTGRES:
            raise
        if settings.is_production:
            logger.error("postgres_write_failed err=%s", type(exc).__name__)
        else:
            logger.debug("postgres_write_skipped err=%s", type(exc).__name__)


async def fetch_rows(query: str, *args: Any) -> list[dict[str, Any]]:
    from ..config import get_settings

    settings = get_settings()
    if not db_configured():
        return []
    try:
        pool = await get_pool()
        if pool is None:
            if settings.STRICT_POSTGRES:
                raise RuntimeError("Postgres pool unavailable")
            return []
        async with pool.acquire() as conn:
            rows = await conn.fetch(query, *args)
            return [dict(r) for r in rows]
    except Exception as exc:
        if settings.STRICT_POSTGRES:
            raise
        if settings.is_production:
            logger.error("postgres_read_failed err=%s", type(exc).__name__)
        else:
            logger.debug("postgres_read_skipped err=%s", type(exc).__name__)
        return []
