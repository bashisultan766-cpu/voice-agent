"""
Shopify circuit breaker — stops live mutation calls after repeated failures.
Cache reads may still proceed when callers set allow_cache=True.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

_FAILURE_THRESHOLD = 5
_COOLDOWN_SEC = 60.0

_failures: list[float] = []
_open_until: float = 0.0


def _record_failure() -> None:
    global _open_until
    now = time.monotonic()
    _failures.append(now)
    cutoff = now - _COOLDOWN_SEC
    while _failures and _failures[0] < cutoff:
        _failures.pop(0)
    if len(_failures) >= _FAILURE_THRESHOLD:
        _open_until = now + _COOLDOWN_SEC
        logger.error(
            "shopify_circuit_open failures=%d cooldown_sec=%.0f",
            len(_failures),
            _COOLDOWN_SEC,
        )


def _record_success() -> None:
    _failures.clear()


def is_circuit_open() -> bool:
    return time.monotonic() < _open_until


def reset_circuit_for_tests() -> None:
    global _open_until
    _failures.clear()
    _open_until = 0.0


def circuit_open_error() -> dict[str, Any]:
    return {
        "errors": [
            {
                "message": "Shopify is temporarily unavailable. Please try again shortly.",
                "extensions": {"code": "SHOPIFY_CIRCUIT_OPEN"},
            }
        ]
    }


def _has_usable_shopify_data(result: dict[str, Any]) -> bool:
    data = result.get("data") or {}
    orders = data.get("orders") or {}
    if orders.get("edges"):
        return True
    if data.get("order"):
        return True
    return False


async def guarded_execute(
    fn: Callable[[], Awaitable[dict[str, Any]]],
    *,
    allow_when_open: bool = False,
) -> dict[str, Any]:
    if is_circuit_open() and not allow_when_open:
        return circuit_open_error()
    try:
        result = await fn()
        if result.get("errors") and not _has_usable_shopify_data(result):
            _record_failure()
        else:
            _record_success()
        return result
    except Exception:
        _record_failure()
        raise
