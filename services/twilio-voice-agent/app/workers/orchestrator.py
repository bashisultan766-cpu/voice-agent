"""
WorkerOrchestrator — routes intents to workers and runs them in two waves.

v4.2 changes:
- ALL intents now have workers (conversational intents get lightweight workers).
- Wave 1: parallel domain workers (product, order, facility, etc.).
- Wave 2: ResponsePlanWorker receives the Wave 1 bundle → builds response_plan.
- WORKER_PATH_INTENTS includes all intents (no more fallback to run_agent_turn).

Rules:
- Never calls OpenAI.
- All failures caught per-worker.
- Returns WorkerBundle even if all workers fail.
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
# v4.2 new workers
from .speech_cleanup_worker import SpeechCleanupWorker
from .isbn_fragment_worker import ISBNFragmentAccumulatorWorker
from .email_fragment_worker import EmailFragmentAccumulatorWorker
from .book_title_extractor_worker import BookTitleExtractorWorker
from .quantity_extractor_worker import QuantityExtractorWorker
from .conversation_memory_worker import ConversationMemoryWorker
from .caller_memory_worker import CallerMemoryWorker
from .availability_backorder_worker import AvailabilityBackorderWorker
from .product_details_worker import ProductDetailsWorker
from .address_update_worker import AddressUpdateWorker
from .cancellation_worker import CancellationWorker
from .payment_safety_worker import PaymentSafetyWorker
from .response_plan_worker import ResponsePlanWorker

if TYPE_CHECKING:
    from ..pipeline.router import IntentResult
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

# Intent → Wave 1 worker names (run in parallel before ResponsePlanWorker).
_INTENT_WORKERS: dict[str, list[str]] = {
    # ── Product / ISBN ─────────────────────────────────────────────────────────
    "isbn_search":          ["product_isbn", "isbn_fragment"],
    "product_search":       ["product_search", "book_title_extractor"],
    "author_search":        ["product_search"],
    "book_title_search":    ["product_search", "book_title_extractor"],
    "price_question":       ["product_search", "price_inventory"],
    "multi_book_order":     ["product_search", "price_inventory"],

    # ── Orders ─────────────────────────────────────────────────────────────────
    "order_lookup":         ["caller_identity", "order_lookup", "tracking"],

    # ── Refunds ────────────────────────────────────────────────────────────────
    "refund_status":        ["caller_identity", "order_lookup", "refund"],
    "refund_detail":        ["caller_identity", "order_lookup", "refund"],

    # ── Checkout / payment ─────────────────────────────────────────────────────
    "checkout_request":     ["product_search", "price_inventory", "checkout"],
    "send_payment_link":    ["payment_email", "payment_safety"],

    # ── Shipping ───────────────────────────────────────────────────────────────
    "shipping_question":    ["store_policy", "shipping"],
    "shipping_price":       ["store_policy"],

    # ── Facility / inmate ──────────────────────────────────────────────────────
    "facility_approval":    ["facility_approval"],
    "facility_restriction": ["facility_restriction"],

    # ── Escalation ─────────────────────────────────────────────────────────────
    "escalation":           ["escalation"],
    "human_escalation":     ["escalation"],

    # ── Address / cancellation ─────────────────────────────────────────────────
    "address_update":       ["address_update"],
    "cancellation_request": ["cancellation"],
    "quantity_update":      ["quantity_extractor"],

    # ── Conversational (v4.2: no longer fallback to run_agent_turn) ────────────
    "greeting":             ["speech_cleanup", "caller_memory", "conversation_memory"],
    "confirmation":         ["speech_cleanup", "conversation_memory"],
    "email_capture":        ["email_fragment", "conversation_memory"],
    "email_provided":       ["email_fragment", "conversation_memory"],
    "email_correction":     ["email_fragment", "conversation_memory"],
    "email_confirmation":   ["email_fragment", "conversation_memory"],
    "unknown":              ["speech_cleanup", "conversation_memory"],

    # ── Cart ───────────────────────────────────────────────────────────────────
    "cart_count_question":  ["conversation_memory"],
    "titles_question":      ["conversation_memory"],
}

# All intents go through the worker path in v4.2.
WORKER_PATH_INTENTS: frozenset[str] = frozenset(_INTENT_WORKERS.keys())

# Registry maps worker name → worker instance (instantiated once).
_REGISTRY: dict[str, object] = {
    # Original 17 workers
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
    # v4.2 new workers (14)
    "speech_cleanup":           SpeechCleanupWorker(),
    "isbn_fragment":            ISBNFragmentAccumulatorWorker(),
    "email_fragment":           EmailFragmentAccumulatorWorker(),
    "book_title_extractor":     BookTitleExtractorWorker(),
    "quantity_extractor":       QuantityExtractorWorker(),
    "conversation_memory":      ConversationMemoryWorker(),
    "caller_memory":            CallerMemoryWorker(),
    "availability_backorder":   AvailabilityBackorderWorker(),
    "product_details":          ProductDetailsWorker(),
    "address_update":           AddressUpdateWorker(),
    "cancellation":             CancellationWorker(),
    "payment_safety":           PaymentSafetyWorker(),
    # Wave 2 (managed separately, not in Wave 1)
    "response_plan":            ResponsePlanWorker(),
}


class WorkerOrchestrator:
    """
    Selects and runs workers in two waves based on router intent.

    Wave 1: domain workers run in parallel (product, order, facility…).
    Wave 2: ResponsePlanWorker runs after Wave 1 with the Wave 1 bundle,
            building a deterministic response plan in session.response_plan.
    """

    async def run(
        self,
        router_result: "IntentResult",
        session: "SessionState",
        settings,
    ) -> WorkerBundle:
        timeout_secs = settings.VOICE_TOOL_TIMEOUT_MS / 1000
        entities = router_result.entities

        # ── Wave 1: parallel domain workers ───────────────────────────────────
        bundle = await self._run_wave1(router_result, session, settings, timeout_secs)

        # ── Wave 2: ResponsePlanWorker ─────────────────────────────────────────
        plan_worker: ResponsePlanWorker = _REGISTRY["response_plan"]
        try:
            plan_result = await asyncio.wait_for(
                plan_worker.run(session, entities, settings, worker_bundle=bundle),
                timeout=0.3,  # 300ms hard cap — must be fast
            )
            bundle.results["response_plan"] = plan_result
            bundle.workers_ran.append("response_plan")
        except asyncio.TimeoutError:
            logger.warning("ResponsePlanWorker timed out sid=%s", session.call_sid[:6])
        except Exception:
            logger.exception("ResponsePlanWorker error sid=%s", session.call_sid[:6])

        return bundle

    async def _run_wave1(
        self,
        router_result: "IntentResult",
        session: "SessionState",
        settings,
        timeout_secs: float,
    ) -> WorkerBundle:
        worker_names = _INTENT_WORKERS.get(router_result.intent, [])
        bundle = WorkerBundle(workers_ran=list(worker_names))

        if not worker_names:
            bundle.total_ms = 0.0
            return bundle

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
            "orchestrator wave1 intent=%s workers=%s total=%.0fms sid=%s",
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
