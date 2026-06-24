"""Tool plan executor — mutating tools only after Brain approval (v4.16.0)."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .brain_orchestrator import BrainDecision, ToolPlan
from .brain_prefetch_arbitrator import AcceptedPrefetchContext

if TYPE_CHECKING:
    from ..state.models import SessionState
    from ..workers.base import WorkerBundle

logger = logging.getLogger(__name__)

MUTATING_CATEGORIES = frozenset({
    "cart_mutation", "payment_flow", "email_capture", "escalation",
    "address_update", "cancellation",
})


@dataclass
class ToolPlanExecutionResult:
    worker_bundle: Any = None
    prefetch_reused: list[str] = field(default_factory=list)
    categories_executed: list[str] = field(default_factory=list)
    ms: float = 0.0


class ToolPlanExecutor:
    """Execute Brain-approved tool plans. Prefetch satisfies read-only facts when accepted."""

    async def execute(
        self,
        decision: BrainDecision,
        prefetch_ctx: AcceptedPrefetchContext,
        *,
        session: "SessionState",
        settings,
        user_text: str,
        memory_packet=None,
        runtime_executor=None,
    ) -> ToolPlanExecutionResult:
        t0 = time.monotonic()
        plan = decision.tool_plan
        if plan is None or not plan.approved_by_brain:
            logger.warning("brain_tool_plan_rejected reason=not_brain_approved")
            return ToolPlanExecutionResult()

        logger.info("brain_tool_plan_received intent=%s categories=%s", plan.intent, plan.categories)
        if not plan.categories:
            return ToolPlanExecutionResult()

        self._validate_plan(plan, decision)
        logger.info("brain_tool_plan_validated")

        reused: list[str] = []
        categories_to_run = list(plan.categories)
        read_only_skip: set[str] = set()

        for result in prefetch_ctx.accepted_results:
            if result.requires_live_verification and any(
                c in MUTATING_CATEGORIES for c in categories_to_run
            ):
                continue
            cat = _prefetch_kind_to_category(result.kind)
            if cat and cat in categories_to_run and not result.requires_live_verification:
                read_only_skip.add(cat)
                reused.append(result.result_id)
                logger.info("tool_plan_prefetch_reused result_id=%s category=%s", result.result_id, cat)

        categories_to_run = [c for c in categories_to_run if c not in read_only_skip]
        if reused:
            logger.info("tool_plan_prefetch_reused count=%d", len(reused))

        legacy = _decision_to_legacy(decision, prefetch_ctx)
        from .intent_result_builder import _build_intent_result_from_agent_decision

        router_result = _build_intent_result_from_agent_decision(
            legacy, user_text, session=session, memory_packet=memory_packet,
        )
        if prefetch_ctx.entities_for_tool_plan:
            router_result.entities.update(prefetch_ctx.entities_for_tool_plan)

        mutating = [c for c in categories_to_run if c in MUTATING_CATEGORIES]
        readonly = [c for c in categories_to_run if c not in MUTATING_CATEGORIES]

        if readonly:
            logger.info("tool_plan_readonly_fanout_started categories=%s", readonly)
        if mutating:
            logger.info("tool_plan_mutation_started categories=%s", mutating)
            if "payment_flow" in mutating:
                from ..payment.safety import require_payment_send_ready
                safety = require_payment_send_ready(session)
                if not safety.allowed:
                    raise ValueError(safety.reason or "payment_not_ready")

        if runtime_executor is None:
            raise ValueError("runtime_executor required")

        all_categories = readonly + mutating
        bundle = await runtime_executor(
            all_categories, router_result, session, settings, decision=legacy,
        )
        ms = (time.monotonic() - t0) * 1000
        logger.info("tool_plan_execution_completed ms=%.0f", ms)
        return ToolPlanExecutionResult(
            worker_bundle=bundle,
            prefetch_reused=reused,
            categories_executed=all_categories,
            ms=ms,
        )

    def _validate_plan(self, plan: ToolPlan, decision: BrainDecision) -> None:
        if not plan.approved_by_brain:
            raise ValueError("Tool plan not approved by Brain")
        if plan.mutating or any(c in MUTATING_CATEGORIES for c in plan.categories):
            if decision.response_mode != "needs_tools":
                raise ValueError("Mutating tools require needs_tools response mode")


def _prefetch_kind_to_category(kind: str) -> str | None:
    return {
        "catalog_candidate": "catalog_search",
        "isbn_candidate": "isbn_lookup",
        "publication_candidate": "catalog_search",
        "order_candidate": "order_lookup",
        "refund_candidate": "refund_lookup",
        "facility_candidate": "facility_approval",
        "cart_state": "cart_memory",
        "payment_readiness": "payment_flow",
        "email_parse": "email_capture",
    }.get(kind)


def _decision_to_legacy(decision: BrainDecision, ctx: AcceptedPrefetchContext) -> dict:
    from .brain_orchestrator import brain_decision_to_legacy_dict
    legacy = brain_decision_to_legacy_dict(decision)
    if ctx.entities_for_tool_plan:
        tool_entities = dict(legacy.get("tool_entities") or {})
        tool_entities.update(ctx.entities_for_tool_plan)
        legacy["tool_entities"] = tool_entities
    return legacy
