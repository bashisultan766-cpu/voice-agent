"""CallerMemoryWorker — retrieves caller profile context from session."""
from __future__ import annotations
import time
from .base import WorkerResult


class CallerMemoryWorker:
    name = "caller_memory"

    async def run(self, session, entities, settings) -> WorkerResult:
        t0 = time.monotonic()
        is_returning = getattr(session, "is_returning_caller", False)
        caller_name = session.caller_name or ""
        call_count = getattr(session, "caller_call_count", 0)
        summary = getattr(session, "caller_last_summary", "") or ""
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={
                "is_returning_caller": is_returning,
                "caller_name": caller_name,
                "call_count": call_count,
                "last_summary": summary[:200] if summary else "",
            },
            safe_summary=(
                f"Returning caller: {caller_name}." if is_returning and caller_name else ""
            ),
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
