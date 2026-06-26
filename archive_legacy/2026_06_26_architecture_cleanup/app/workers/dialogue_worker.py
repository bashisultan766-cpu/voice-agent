"""DialogueWorker — runs DialogueManager side effects for cart confirm (v4.3)."""
from __future__ import annotations

import time

from ..dialogue.manager import DialogueManager
from .base import WorkerResult


class DialogueWorker:
    name = "dialogue"

    async def run(self, session, entities, settings) -> WorkerResult:
        t0 = time.monotonic()
        intent = entities.get("intent", "")

        if intent == "add_to_cart":
            product = DialogueManager.apply_cart_confirmation(session)
            if product:
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={"confirmed": product},
                    safe_summary=(
                        f"Added {product.get('title', 'the book')}. "
                        "Would you like to add another book, or should I help you with the payment link?"
                    ),
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="local",
                )
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_candidate",
                safe_summary="I don't have a book waiting to add. Which book would you like?",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={},
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
