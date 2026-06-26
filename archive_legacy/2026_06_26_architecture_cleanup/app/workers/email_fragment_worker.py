"""EmailFragmentAccumulatorWorker — exposes multi-turn email fragment state to bundle."""
from __future__ import annotations
import time
from .base import WorkerResult


class EmailFragmentAccumulatorWorker:
    name = "email_fragment"

    async def run(self, session, entities, settings) -> WorkerResult:
        t0 = time.monotonic()
        fragments = getattr(session, "pending_email_fragments", []) or []
        pending = bool(getattr(session, "pending_email", ""))
        confirmed = bool(getattr(session, "confirmed_email", ""))
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={
                "fragment_count": len(fragments),
                "pending_email": pending,
                "confirmed_email": confirmed,
            },
            safe_summary=(
                f"{len(fragments)} email fragment(s) accumulated."
                if fragments and not pending
                else ""
            ),
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
