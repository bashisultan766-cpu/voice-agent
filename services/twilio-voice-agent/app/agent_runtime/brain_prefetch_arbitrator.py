"""Brain arbitration over speculative prefetch results (v4.16.0)."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from .brain_orchestrator import BrainDecision
from .speculative_prefetch_manager import PrefetchResult, SpeculativePrefetchPacket

logger = logging.getLogger(__name__)

_CONVERSATION_INTENTS = frozenset({
    "small_talk", "presence_check", "identity", "identity_confirmation",
    "meta_complaint", "acknowledgment", "memory_question",
})
_CATALOG_INTENTS = frozenset({
    "catalog_product_search", "newspaper_search", "magazine_search",
    "subscription_search", "book_search", "book_title_search", "isbn_lookup",
    "publication_search", "product_search",
})


@dataclass
class AcceptedPrefetchContext:
    accepted_results: list[PrefetchResult] = field(default_factory=list)
    rejected_results: list[PrefetchResult] = field(default_factory=list)
    facts_for_final_answer: dict = field(default_factory=dict)
    entities_for_tool_plan: dict = field(default_factory=dict)


def arbitrate_prefetch(
    decision: BrainDecision,
    packet: SpeculativePrefetchPacket | None,
) -> AcceptedPrefetchContext:
    ctx = AcceptedPrefetchContext()
    if not packet or not packet.results:
        logger.info("brain_prefetch_review_completed accepted=0 rejected=0")
        return ctx

    logger.info("brain_prefetch_review_started results=%d", len(packet.results))
    mode = decision.response_mode
    intent = decision.intent

    for result in packet.results:
        accept, reason = _should_accept(result, decision, mode, intent)
        if accept:
            ctx.accepted_results.append(result)
            ctx.entities_for_tool_plan.update(
                {k: v for k, v in result.entities.items() if v is not None}
            )
            ctx.facts_for_final_answer.update(result.facts or {})
            decision.accepted_prefetch_ids.append(result.result_id)
            logger.info(
                "brain_prefetch_accepted result_id=%s kind=%s",
                result.result_id, result.kind,
            )
            logger.info("prefetch_result_accepted result_id=%s", result.result_id)
        else:
            ctx.rejected_results.append(result)
            logger.info(
                "brain_prefetch_rejected result_id=%s reason=%s",
                result.result_id, reason,
            )
            logger.info("prefetch_result_ignored reason=%s", reason)

    logger.info(
        "brain_prefetch_review_completed accepted=%d rejected=%d",
        len(ctx.accepted_results), len(ctx.rejected_results),
    )
    return ctx


def _should_accept(
    result: PrefetchResult,
    decision: BrainDecision,
    mode: str,
    intent: str,
) -> tuple[bool, str]:
    if mode in ("direct_answer", "clarify", "out_of_domain_redirect", "domain_answer"):
        if result.kind == "conversation_signal":
            return True, "brain_rejected"
        if result.kind == "out_of_domain_signal" and mode == "out_of_domain_redirect":
            return True, "brain_rejected"
        return False, "brain_rejected"

    if result.kind == "conversation_signal":
        if intent in _CONVERSATION_INTENTS or mode == "direct_answer":
            return True, "brain_rejected"
        return False, "brain_rejected"

    if result.kind in ("catalog_candidate", "publication_candidate", "isbn_candidate"):
        if intent in _CATALOG_INTENTS or mode == "needs_tools":
            if result.kind == "catalog_candidate" and intent in _CONVERSATION_INTENTS:
                return False, "brain_rejected"
            if result.confidence < 0.5:
                return False, "brain_rejected"
            return True, "brain_rejected"
        return False, "brain_rejected"

    if result.kind == "order_candidate":
        if intent in ("order_lookup", "order_status") or "order" in intent:
            if result.confidence >= 0.8:
                return True, "brain_rejected"
            return False, "brain_rejected"
        return False, "brain_rejected"

    if result.kind == "refund_candidate":
        if "refund" in intent:
            return True, "brain_rejected"
        return False, "brain_rejected"

    if result.kind == "facility_candidate":
        if "facility" in intent:
            return True, "brain_rejected"
        return False, "brain_rejected"

    if result.kind == "cart_state":
        if mode == "needs_tools" or "cart" in intent or "payment" in intent:
            return True, "brain_rejected"
        return False, "brain_rejected"

    if result.kind == "payment_readiness":
        if "payment" in intent or decision.tool_plan and "payment_flow" in (decision.tool_plan.categories or []):
            return True, "brain_rejected"
        return False, "brain_rejected"

    if result.kind == "email_parse":
        if "email" in intent or (decision.missing_entities and "email" in decision.missing_entities):
            return True, "brain_rejected"
        return False, "brain_rejected"

    if result.kind == "out_of_domain_signal":
        if mode == "out_of_domain_redirect":
            return True, "brain_rejected"
        if mode == "needs_tools" and decision.domain_status == "domain_adjacent":
            return True, "brain_rejected"
        return False, "brain_rejected"

    return False, "brain_rejected"
