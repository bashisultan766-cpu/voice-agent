"""ConversationMemoryWorker — surfaces relevant session state into the bundle."""
from __future__ import annotations
import time
from .base import WorkerResult


class ConversationMemoryWorker:
    name = "conversation_memory"

    async def run(self, session, entities, settings) -> WorkerResult:
        t0 = time.monotonic()
        isbn_count = len(getattr(session, "isbn_history", []) or [])
        cart = getattr(session, "cart_items", []) or []
        cart_count = len([
            c for c in cart
            if isinstance(c, dict) and c.get("confirmation_status") != "rejected"
        ])
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={
                "turn_count": session.turn_count,
                "isbn_history_count": isbn_count,
                "cart_item_count": cart_count,
                "last_order_number": session.last_order_number or "",
                "last_product_title": session.last_product_title or "",
                "payment_flow_status": getattr(session, "payment_flow_status", "idle") or "idle",
                "caller_name": session.caller_name or "",
            },
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
