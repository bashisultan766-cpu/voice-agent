"""Parallel multi-identifier catalog search (v4.15.0)."""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine

from ..payment.certification_config import catalog_identifier_timeout_ms, catalog_parallel_limit

logger = logging.getLogger(__name__)


@dataclass
class IdentifierSearchResult:
    identifier: dict[str, str]
    ok: bool
    candidates: list[Any] = field(default_factory=list)
    error: str = ""


@dataclass
class MultiIdentifierSearchResult:
    found: list[IdentifierSearchResult]
    failed: list[IdentifierSearchResult]
    summary_message: str = ""


async def _run_with_timeout(coro: Coroutine, timeout_ms: int) -> Any:
    return await asyncio.wait_for(coro, timeout=timeout_ms / 1000.0)


async def search_identifiers_parallel(
    identifiers: list[dict[str, str]],
    search_fn: Callable[[dict[str, str]], Coroutine],
    *,
    sid: str = "",
) -> MultiIdentifierSearchResult:
    """Run read-only identifier searches concurrently with limit and timeout."""
    if not identifiers:
        return MultiIdentifierSearchResult(found=[], failed=[])

    limit = catalog_parallel_limit()
    timeout_ms = catalog_identifier_timeout_ms()
    short_sid = sid[:6] if sid else "?"
    logger.info("multi_identifier_search_started sid=%s count=%d", short_sid, len(identifiers))

    sem = asyncio.Semaphore(limit)
    found: list[IdentifierSearchResult] = []
    failed: list[IdentifierSearchResult] = []

    async def _one(ident: dict[str, str]) -> IdentifierSearchResult:
        label = ident.get("value") or ident.get("type") or "?"
        async with sem:
            logger.info(
                "multi_identifier_worker_started sid=%s identifier=%s",
                short_sid,
                label[:30],
            )
            try:
                result = await _run_with_timeout(search_fn(ident), timeout_ms)
                ok = bool(result)
                logger.info(
                    "multi_identifier_worker_completed sid=%s identifier=%s ok=%s",
                    short_sid,
                    label[:30],
                    ok,
                )
                return IdentifierSearchResult(identifier=ident, ok=ok, candidates=result if isinstance(result, list) else [])
            except asyncio.TimeoutError:
                logger.info(
                    "multi_identifier_worker_completed sid=%s identifier=%s ok=False reason=timeout",
                    short_sid,
                    label[:30],
                )
                return IdentifierSearchResult(identifier=ident, ok=False, error="timeout")
            except Exception as exc:
                logger.info(
                    "multi_identifier_worker_completed sid=%s identifier=%s ok=False reason=error",
                    short_sid,
                    label[:30],
                )
                return IdentifierSearchResult(identifier=ident, ok=False, error=str(exc)[:80])

    results = await asyncio.gather(*[_one(i) for i in identifiers])
    for r in results:
        if r.ok and r.candidates is not None:
            found.append(r)
        elif r.ok:
            found.append(r)
        else:
            failed.append(r)

    logger.info(
        "multi_identifier_search_completed sid=%s found=%d failed=%d",
        short_sid,
        len(found),
        len(failed),
    )

    found_names = [r.identifier.get("value", "") for r in found if r.identifier.get("value")]
    failed_names = [r.identifier.get("value", "") for r in failed if r.identifier.get("value")]

    if found_names and failed_names:
        f = ", ".join(found_names[:3])
        msg = (
            f"I found {f}. I had trouble checking {failed_names[0]}. "
            "Would you like to add the ones I found?"
        )
    elif found_names:
        joined = found_names[0] if len(found_names) == 1 else ", ".join(found_names[:-1]) + f", and {found_names[-1]}"
        msg = f"I found {joined}. Would you like me to add all of them to your order?"
    else:
        msg = "I couldn't find those items. Would you like to try another identifier?"

    return MultiIdentifierSearchResult(found=found, failed=failed, summary_message=msg)


def search_identifiers_parallel_sync(
    identifiers: list[dict[str, str]],
    search_fn: Callable[[dict[str, str]], list],
    *,
    sid: str = "",
) -> MultiIdentifierSearchResult:
    """Synchronous wrapper for tests."""

    async def _async_fn(ident: dict[str, str]) -> list:
        return search_fn(ident)

    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # Fallback sequential for nested loop contexts (tests)
            found, failed = [], []
            for ident in identifiers:
                try:
                    result = search_fn(ident)
                    entry = IdentifierSearchResult(identifier=ident, ok=True, candidates=result or [])
                    found.append(entry)
                except Exception as exc:
                    failed.append(IdentifierSearchResult(identifier=ident, ok=False, error=str(exc)))
            joined_found = [r.identifier.get("value", "") for r in found]
            msg = f"I found {', '.join(joined_found)}." if joined_found else "I couldn't find those items."
            return MultiIdentifierSearchResult(found=found, failed=failed, summary_message=msg)
        return loop.run_until_complete(search_identifiers_parallel(identifiers, _async_fn, sid=sid))
    except RuntimeError:
        return asyncio.run(search_identifiers_parallel(identifiers, _async_fn, sid=sid))
