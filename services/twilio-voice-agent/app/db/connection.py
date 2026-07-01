"""
Async Postgres connection pool — optional unless DATABASE_URL is set.

Schema is applied on first connect. STRICT_POSTGRES=true fails fast when DB is
unavailable at startup or on write errors.

When Postgres is missing or unreachable (STRICT_POSTGRES=false), persistence is
degraded gracefully: a circuit breaker skips writes during cooldown so live calls
are not slowed or log-spammed.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_pool: Any = None
_test_pool_override: Any = None
_schema_applied: bool = False

_postgres_disabled: bool = False
_postgres_cooldown_until: float = 0.0
_postgres_failure_count: int = 0
_postgres_cooldown_logged: bool = False
_postgres_startup_warned: bool = False

COOLDOWN_SECONDS = 300
FAILURES_BEFORE_COOLDOWN = 2

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


def reset_postgres_circuit_for_tests() -> None:
    """Reset circuit-breaker state between tests."""
    global _postgres_disabled, _postgres_cooldown_until, _postgres_failure_count
    global _postgres_cooldown_logged, _postgres_startup_warned, _pool, _schema_applied
    _postgres_disabled = False
    _postgres_cooldown_until = 0.0
    _postgres_failure_count = 0
    _postgres_cooldown_logged = False
    _postgres_startup_warned = False
    _pool = None
    _schema_applied = False


def db_configured() -> bool:
    from ..config import get_settings

    return bool((get_settings().DATABASE_URL or "").strip())


def _cooldown_active() -> bool:
    global _postgres_cooldown_logged, _postgres_cooldown_until
    if _postgres_cooldown_until and time.monotonic() >= _postgres_cooldown_until:
        _postgres_cooldown_until = 0.0
        _postgres_cooldown_logged = False
        return False
    return bool(_postgres_cooldown_until and time.monotonic() < _postgres_cooldown_until)


def postgres_writes_enabled() -> bool:
    """True when Postgres writes should be attempted (not disabled or in cooldown)."""
    if not db_configured():
        return False
    if _postgres_disabled:
        return False
    if _cooldown_active():
        return False
    return True


def postgres_reads_enabled() -> bool:
    """Reads follow the same availability gate as writes in degraded mode."""
    return postgres_writes_enabled()


def disable_postgres_persistence(reason: str) -> None:
    """Permanently disable Postgres persistence for this process."""
    global _postgres_disabled
    if not _postgres_disabled:
        _postgres_disabled = True
        logger.warning("postgres_persistence_disabled reason=%s", reason)


def _record_postgres_failure(exc: Exception) -> None:
    """Trip circuit breaker after repeated connection failures."""
    global _postgres_failure_count, _postgres_cooldown_until, _postgres_cooldown_logged
    _postgres_failure_count += 1
    if _postgres_failure_count >= FAILURES_BEFORE_COOLDOWN:
        _postgres_failure_count = 0
        _postgres_cooldown_until = time.monotonic() + COOLDOWN_SECONDS
        if not _postgres_cooldown_logged:
            _postgres_cooldown_logged = True
            logger.warning(
                "postgres_circuit_open cooldown_sec=%d err=%s",
                COOLDOWN_SECONDS,
                type(exc).__name__,
            )


def _warn_startup_once(message: str, *args: Any) -> None:
    global _postgres_startup_warned
    if not _postgres_startup_warned:
        _postgres_startup_warned = True
        logger.warning(message, *args)


async def get_pool() -> Any:
    global _pool
    if _test_pool_override is not None:
        return _test_pool_override
    if _pool is not None:
        return _pool
    if not db_configured():
        return None
    if not postgres_writes_enabled():
        return None

    import asyncpg

    from ..config import get_settings

    settings = get_settings()
    try:
        _pool = await asyncpg.create_pool(
            settings.DATABASE_URL,
            min_size=1,
            max_size=5,
            command_timeout=10,
        )
        await ensure_schema(_pool)
        return _pool
    except Exception as exc:
        _record_postgres_failure(exc)
        _warn_startup_once(
            "postgres_unavailable err=%s persistence=degraded",
            type(exc).__name__,
        )
        return None


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
    """Fail fast when STRICT_POSTGRES is enabled; degrade gracefully otherwise."""
    from ..config import get_settings

    settings = get_settings()
    if not db_configured():
        if settings.STRICT_POSTGRES:
            raise RuntimeError("STRICT_POSTGRES=true requires DATABASE_URL to be set")
        _warn_startup_once("postgres_not_configured persistence=disabled")
        disable_postgres_persistence("missing_database_url")
        return
    try:
        pool = await get_pool()
        if pool is None:
            raise ConnectionError("Postgres pool could not be created")
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
    except Exception as exc:
        if settings.STRICT_POSTGRES:
            raise RuntimeError(
                f"STRICT_POSTGRES=true but Postgres is unreachable: {type(exc).__name__}"
            ) from exc
        disable_postgres_persistence(f"startup_unreachable:{type(exc).__name__}")
        _warn_startup_once(
            "postgres_unavailable err=%s persistence=degraded",
            type(exc).__name__,
        )


async def execute_write(query: str, *args: Any) -> None:
    """Run a write query; honor STRICT_POSTGRES on failure."""
    from ..config import get_settings

    settings = get_settings()
    if not db_configured():
        return
    if not postgres_writes_enabled():
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
        _record_postgres_failure(exc)
        if settings.STRICT_POSTGRES:
            raise


async def fetch_rows(query: str, *args: Any) -> list[dict[str, Any]]:
    from ..config import get_settings

    settings = get_settings()
    if not db_configured():
        return []
    if not postgres_reads_enabled():
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
        _record_postgres_failure(exc)
        if settings.STRICT_POSTGRES:
            raise
        return []
