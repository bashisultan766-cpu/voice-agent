"""
WorkerOrchestrator — routes intents to workers and runs them concurrently.

Rules:
- Receives IntentResult from the deterministic router.
- Selects the appropriate worker(s) based on intent.
- Runs all selected workers concurrently with per-worker timeouts.
- Returns a WorkerBundle; partial results are returned if any worker fails/times out.
- Never calls OpenAI.
- Never crashes the call — all failures are caught per-worker.

v4.1 additions:
- facility_approval, facility_restriction intents → facility workers
- email_provided, email_correction, email_confirmation → conversational fallback
- multi_book_order, book_title_search → product workers
- refund_detail → refund worker (same as refund_status but intent is more specific)
- cancellation_request, address_update, quantity_update → fallback (LLM handles)
- shipping_price → store_policy worker
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

from .base import WorkerBundle, WorkerResult
from .caller_identity_worker import CallerIdentityWorker
from .customer_profile_worker import CustomerProfileWorker
from .product_isbn_worker import ProductISBNWorker
from .product_search_worker import ProductSearchWorker
from .price_inventory_worker import PriceInventoryWorker
from .order_lookup_worker import OrderLookupWorker
from .tracking_worker import TrackingWorker
from .refund_worker import RefundWorker
from .shipping_worker import ShippingWorker
from .checkout_worker import CheckoutWorker
from .payment_email_worker import PaymentEmailWorker
from .escalation_worker import EscalationWorker
from .store_policy_worker import StorePolicyWorker
from .facility_approval_worker import FacilityApprovalWorker
from .facility_restriction_worker import FacilityRestrictionWorker
from .facility_policy_notes_worker import FacilityPolicyNotesWorker
from .order_facility_review_worker import OrderFacilityReviewWorker

if TYPE_CHECKING:
    from ..pipeline.router import IntentResult
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

# Intent → list of worker names to run concurrently.
# Order within a list has no effect on concurrency — all run in parallel.
_INTENT_WORKERS: dict[str, list[str]] = {
    # Product / ISBN
    "isbn_search":          ["product_isbn"],
    "product_search":       ["product_search"],
    "author_search":        ["product_search"],
    "book_title_search":    ["product_search"],
    "price_question":       ["product_search", "price_inventory"],
    "multi_book_order":     ["product_search", "price_inventory"],

    # Orders
    "order_lookup":         ["caller_identity", "order_lookup", "tracking"],

    # Refunds
    "refund_status":        ["caller_identity", "order_lookup", "refund"],
    "refund_detail":        ["caller_identity", "order_lookup", "refund"],

    # Checkout / payment
    "checkout_request":     ["product_search", "price_inventory", "checkout"],
    "send_payment_link":    ["payment_email"],

    # Price — direct query after a product is already in session
    "price_question":       ["price_inventory"],

    # Shipping
    "shipping_question":    ["store_policy", "shipping"],
    "shipping_price":       ["store_policy"],

    # Facility / inmate
    "facility_approval":    ["facility_approval"],
    "facility_restriction": ["facility_restriction"],

    # Escalation
    "escalation":           ["escalation"],
    "human_escalation":     ["escalation"],

    # Conversational intents — handled by run_agent_turn fallback.
    "greeting":             [],
    "confirmation":         [],
    "email_capture":        [],
    "email_provided":       [],
    "email_correction":     [],
    "email_confirmation":   [],
    "cancellation_request": [],
    "address_update":       [],
    "quantity_update":      [],
    "unknown":              [],
}

# Intents that should take the worker path (non-empty worker lists above).
WORKER_PATH_INTENTS: frozenset[str] = frozenset(
    k for k, v in _INTENT_WORKERS.items() if v
)

# Registry maps worker name → worker instance (instantiated once).
_REGISTRY: dict[str, object] = {
    "caller_identity":          CallerIdentityWorker(),
    "customer_profile":         CustomerProfileWorker(),
    "product_isbn":             ProductISBNWorker(),
    "product_search":           ProductSearchWorker(),
    "price_inventory":          PriceInventoryWorker(),
    "order_lookup":             OrderLookupWorker(),
    "tracking":                 TrackingWorker(),
    "refund":                   RefundWorker(),
    "shipping":                 ShippingWorker(),
    "checkout":                 CheckoutWorker(),
    "payment_email":            PaymentEmailWorker(),
    "escalation":               EscalationWorker(),
    "store_policy":             StorePolicyWorker(),
    "facility_approval":        FacilityApprovalWorker(),
    "facility_restriction":     FacilityRestrictionWorker(),
    "facility_policy_notes":    FacilityPolicyNotesWorker(),
    "order_facility_review":    OrderFacilityReviewWorker(),
}


class WorkerOrchestrator:
    """
    Selects and runs workers concurrently based on router intent.

    All workers run in parallel. A per-worker timeout (VOICE_TOOL_TIMEOUT_MS)
    prevents slow Shopify calls from blocking the whole turn.
    """

    async def run(
        self,
        router_result: "IntentResult",
        session: "SessionState",
        settings,
    ) -> WorkerBundle:
        """
        Dispatch workers for the given intent and return aggregated results.

        Returns a WorkerBundle even if all workers fail or time out.
        Never raises.
        """
        worker_names = _INTENT_WORKERS.get(router_result.intent, [])
        bundle = WorkerBundle(workers_ran=list(worker_names))

        if not worker_names:
            return bundle

        timeout_secs = settings.VOICE_TOOL_TIMEOUT_MS / 1000
        entities = router_result.entities

        t0 = time.monotonic()
        tasks = {
            name: asyncio.create_task(
                _run_one(name, session, entities, settings, timeout_secs),
                name=f"worker-{name}",
            )
            for name in worker_names
            if name in _REGISTRY
        }

        results = await asyncio.gather(*tasks.values(), return_exceptions=True)

        for name, result in zip(tasks.keys(), results):
            if isinstance(result, WorkerResult):
                bundle.results[name] = result
                if result.source == "shopify":
                    bundle.shopify_api_ms = max(bundle.shopify_api_ms, result.latency_ms)
                elif result.source == "resend":
                    bundle.resend_api_ms = max(bundle.resend_api_ms, result.latency_ms)
            else:
                bundle.results[name] = WorkerResult(
                    worker_name=name,
                    success=False,
                    error_code="orchestrator_error",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="none",
                )

        bundle.total_ms = (time.monotonic() - t0) * 1000
        logger.debug(
            "orchestrator intent=%s workers=%s total=%.0fms sid=%s",
            router_result.intent,
            list(bundle.results.keys()),
            bundle.total_ms,
            session.call_sid[:6],
        )
        return bundle


async def _run_one(
    name: str,
    session: "SessionState",
    entities: dict,
    settings,
    timeout_secs: float,
) -> WorkerResult:
    """Run a single worker with timeout. Returns WorkerResult; never raises."""
    worker = _REGISTRY.get(name)
    if worker is None:
        return WorkerResult(
            worker_name=name,
            success=False,
            error_code="not_found",
            source="none",
        )
    try:
        return await asyncio.wait_for(
            worker.run(session, entities, settings),
            timeout=timeout_secs,
        )
    except asyncio.TimeoutError:
        logger.warning("Worker %s timed out after %.1fs", name, timeout_secs)
        return WorkerResult(
            worker_name=name,
            success=False,
            error_code="timeout",
            source="none",
        )
    except Exception:
        logger.exception("Worker %s raised unexpectedly", name)
        return WorkerResult(
            worker_name=name,
            success=False,
            error_code="error",
            source="none",
        )


_orchestrator: WorkerOrchestrator | None = None


def get_orchestrator() -> WorkerOrchestrator:
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = WorkerOrchestrator()
    return _orchestrator
