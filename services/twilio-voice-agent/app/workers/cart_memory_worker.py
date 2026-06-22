"""CartMemoryWorker — surfaces cart/ISBN memory for dialogue answers (v4.3)."""
from __future__ import annotations

import time

from ..cart.session import get_ledger
from ..dialogue.manager import DialogueManager
from .base import WorkerResult


class CartMemoryWorker:
    name = "cart_memory"

    async def run(self, session, entities, settings) -> WorkerResult:
        t0 = time.monotonic()
        ledger = get_ledger(session)
        intent = entities.get("intent") or entities.get("memory_action", "")
        summary = DialogueManager.build_memory_response(session, intent)
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={
                "isbn_count": len(getattr(session, "isbn_history", []) or ledger.isbn_provided),
                "cart_count": ledger.confirmed_count() or ledger.count(),
                "titles": ledger.found_titles_ordered(),
                "not_found": ledger.isbn_not_found,
                "summary": summary,
            },
            safe_summary=summary,
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
