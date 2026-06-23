"""Parallel worker fanout for Eric Agent Runtime (v4.11)."""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from .fact_packet import FactPacket, build_fact_packet
from .types import SupervisorDecision
from .worker_packet import MUTATING_WORKERS, READ_ONLY_WORKERS, WorkerPacket

if TYPE_CHECKING:
    from ..pipeline.router import IntentResult
    from ..state.models import SessionState
    from ..workers.base import WorkerBundle

logger = logging.getLogger(__name__)

_WORKER_TO_INTENT_EXTRA: dict[str, list[str]] = {
    "catalog_search": ["product_search", "book_title_extractor", "availability_backorder"],
    "isbn_lookup": ["product_isbn", "isbn_fragment", "availability_backorder"],
    "order_lookup": ["caller_identity", "order_lookup", "tracking"],
    "shipping_lookup": ["store_policy", "shipping"],
    "refund_lookup": ["caller_identity", "order_lookup", "refund"],
    "facility_approval": ["facility_approval"],
    "facility_restriction": ["facility_restriction"],
    "address_update": ["address_update"],
    "cancellation": ["cancellation"],
    "payment_flow": ["payment_flow", "cart_mutation"],
    "email_capture": ["email_fragment", "conversation_memory"],
    "cart_memory": ["cart_memory"],
    "escalation": ["escalation"],
    "store_info": ["store_info"],
}


def _payment_ready(session: "SessionState") -> bool:
    pfs = getattr(session, "payment_flow_status", "idle") or "idle"
    if pfs == "awaiting_send_confirmation":
        return bool(getattr(session, "confirmed_email", ""))
    if pfs in ("awaiting_email_confirmation", "awaiting_email"):
        return False
    return True


class WorkerFanout:
    """Execute deterministic workers — parallel read-only, sequential mutating."""

    async def run(
        self,
        decision: SupervisorDecision,
        intent_result: "IntentResult",
        session: "SessionState",
        settings,
    ) -> "WorkerBundle":
        from ..workers.orchestrator import get_orchestrator

        sid = session.call_sid[:6]
        packet = WorkerPacket(requests=list(decision.worker_requests))
        worker_names = packet.worker_names()

        if not worker_names:
            logger.info("eric_worker_fanout_start sid=%s workers=0", sid)
            bundle = await get_orchestrator().run(intent_result, session, settings)
            logger.info(
                "eric_fact_packet sid=%s facts=%d",
                sid, len(build_fact_packet(bundle, session).customer_facing_facts),
            )
            return bundle

        read_only = [w.worker for w in packet.read_only()]
        mutating = [w.worker for w in packet.mutating()]

        logger.info(
            "eric_worker_fanout_start sid=%s workers=%d",
            sid, len(worker_names),
        )

        orchestrator = get_orchestrator()

        if "payment_flow" in mutating and not _payment_ready(session):
            logger.info(
                "eric_worker_result sid=%s worker=payment_flow status=blocked_unconfirmed_email",
                sid,
            )
            mutating = [w for w in mutating if w != "payment_flow"]

        bundle = await orchestrator.run(intent_result, session, settings)

        for name in worker_names:
            status = "ok" if name in bundle.workers_ran else "delegated"
            logger.info(
                "eric_worker_result sid=%s worker=%s status=%s parallel=%s",
                sid, name, status,
                name in READ_ONLY_WORKERS,
            )

        fp = build_fact_packet(bundle, session)
        logger.info("eric_fact_packet sid=%s facts=%d", sid, len(fp.customer_facing_facts))
        return bundle


_fanout: WorkerFanout | None = None


def get_worker_fanout() -> WorkerFanout:
    global _fanout
    if _fanout is None:
        _fanout = WorkerFanout()
    return _fanout
