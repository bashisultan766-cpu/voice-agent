"""Worker request packet types (v4.11)."""
from __future__ import annotations

from dataclasses import dataclass, field

from .types import WorkerRequest

READ_ONLY_WORKERS = frozenset({
    "catalog_search", "isbn_lookup", "order_lookup", "shipping_lookup",
    "facility_approval", "facility_restriction", "cart_memory", "store_info",
    "refund_lookup",
})

MUTATING_WORKERS = frozenset({
    "payment_flow", "email_capture", "cancellation", "escalation",
})


@dataclass
class WorkerPacket:
    requests: list[WorkerRequest] = field(default_factory=list)

    def read_only(self) -> list[WorkerRequest]:
        return [r for r in self.requests if r.worker in READ_ONLY_WORKERS]

    def mutating(self) -> list[WorkerRequest]:
        return [r for r in self.requests if r.worker in MUTATING_WORKERS]

    def worker_names(self) -> list[str]:
        return [r.worker for r in self.requests if r.worker and r.worker != "none"]
