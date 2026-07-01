"""
Execution policy resolver — single authority for LLM vs deterministic routing.

Feeds existing FSM + classifier + brain-gate signals into one decision.
Does not replace FSMs or brain gates; orchestrates them.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Optional

if TYPE_CHECKING:
    from ..state.models import SessionState
    from .fast_classifier import ClassificationResult

logger = logging.getLogger(__name__)

EXECUTION_POLICY_VERSION = "v1.0"

ExecutionPolicy = Literal["deterministic", "short_circuit", "llm_allowed"]

EXECUTION_POLICY_DETERMINISTIC: ExecutionPolicy = "deterministic"
EXECUTION_POLICY_SHORT_CIRCUIT: ExecutionPolicy = "short_circuit"
EXECUTION_POLICY_LLM_ALLOWED: ExecutionPolicy = "llm_allowed"

_CLASSIFIER_CONFIDENCE_THRESHOLD = 0.6


@dataclass
class ExecutionFsmState:
    """Snapshot of workflow FSM + runtime gates for policy resolution."""

    product_commerce_status: str = "idle"
    payment_flow_active: bool = False
    order_awaiting_order_number: bool = False
    voice_stage: str = "idle"
    brain_gate_active: bool = False
    support_handoff_active: bool = False
    product_commerce_fsm_active: bool = False
    active_workflow: str = ""
    workflow_llm_blocked: bool = False


def build_execution_fsm_state(
    session: "SessionState",
    *,
    turn_mode: str = "",
    voice_stage: str = "idle",
    brain_gate_active: bool = False,
    active_workflow: str = "",
    workflow_llm_blocked: bool = False,
) -> ExecutionFsmState:
    """Collect FSM signals from existing workflow_isolation + order state."""
    from ..agent_runtime.order_flow_state import STATUS_AWAITING_ORDER_NUMBER
    from ..agent_runtime.workflow_isolation import (
        payment_workflow_active,
        product_commerce_fsm_active,
        product_commerce_status,
        support_handoff_active,
    )

    ofs = getattr(session, "order_flow_status", "idle") or "idle"
    stage = (voice_stage or "idle").strip() or "idle"

    return ExecutionFsmState(
        product_commerce_status=product_commerce_status(session),
        payment_flow_active=payment_workflow_active(session, turn_mode),
        order_awaiting_order_number=(
            stage == "awaiting_order_number"
            or ofs == STATUS_AWAITING_ORDER_NUMBER
        ),
        voice_stage=stage,
        brain_gate_active=bool(brain_gate_active),
        support_handoff_active=support_handoff_active(session),
        product_commerce_fsm_active=product_commerce_fsm_active(session),
        active_workflow=(active_workflow or "").strip(),
        workflow_llm_blocked=bool(workflow_llm_blocked),
    )


def resolve_brain_gate_reply(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> tuple[str, str] | None:
    """
    Unified brain-gate replay — delegates to existing try_*_brain_gate helpers.

    Returns (reply_text, gate_name) or None.
    """
    from ..agent_runtime.commerce_flow_state import try_commerce_brain_gate
    from ..agent_runtime.order_flow_state import try_order_brain_gate
    from ..agent_runtime.payment_flow_state import try_payment_brain_gate
    from ..agent_runtime.workflow_isolation import (
        commerce_handling_allowed,
        order_handling_allowed,
        payment_handling_allowed,
    )
    from ..payment.payment_state_machine import payment_email_turn_priority

    if order_handling_allowed(session, turn_mode, caller_text):
        reply = try_order_brain_gate(session, caller_text, turn_mode=turn_mode)
        if reply:
            return reply, "order"
    if commerce_handling_allowed(session, turn_mode, caller_text):
        reply = try_commerce_brain_gate(session, caller_text, turn_mode=turn_mode)
        if reply:
            return reply, "commerce"
    if payment_handling_allowed(session, turn_mode, caller_text) or payment_email_turn_priority(
        session, turn_mode,
    ):
        reply = try_payment_brain_gate(session, caller_text, turn_mode=turn_mode)
        if reply:
            return reply, "payment"
    return None


def probe_brain_gate_active(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> bool:
    """True when an existing brain gate would replay deterministic copy."""
    from ..agent_runtime.commerce_flow_state import try_commerce_brain_gate
    from ..agent_runtime.order_flow_state import try_order_brain_gate
    from ..agent_runtime.payment_flow_state import try_payment_brain_gate

    if try_order_brain_gate(session, caller_text, turn_mode=turn_mode):
        return True
    if try_commerce_brain_gate(session, caller_text, turn_mode=turn_mode):
        return True
    if try_payment_brain_gate(session, caller_text, turn_mode=turn_mode):
        return True
    return False


def _pcs_requires_deterministic(pcs: str) -> bool:
    from ..agent_runtime.workflow_isolation import (
        PCS_AWAITING_QUANTITY,
        PCS_CART_BUILDING,
        PCS_CART_CONFIRMED,
    )

    return pcs in {
        PCS_AWAITING_QUANTITY,
        PCS_CART_BUILDING,
        PCS_CART_CONFIRMED,
    }


def _classifier_requests_short_circuit(
    classifier_result: Optional["ClassificationResult"],
) -> bool:
    """Classifier instant/skip paths or low-confidence / fallback routing."""
    if classifier_result is None:
        return True

    from .fast_classifier import LOCK_LLM_BRAIN

    if classifier_result.action in ("instant", "ack_then_brain"):
        return True
    if classifier_result.skip_brain or classifier_result.skip_llm:
        return True
    if (
        classifier_result.locked_workflow
        and classifier_result.locked_workflow != LOCK_LLM_BRAIN
    ):
        return True
    if classifier_result.product_intent_detected or classifier_result.is_product_search:
        return True

    reason = (classifier_result.reason or "").lower()
    if "fallback" in reason:
        return True

    meta = classifier_result.metadata or {}
    confidence = meta.get("confidence")
    if confidence is not None:
        try:
            if float(confidence) < _CLASSIFIER_CONFIDENCE_THRESHOLD:
                return True
        except (TypeError, ValueError):
            pass

    return False


def resolve_execution_policy(
    session: "SessionState",
    classifier_result: Optional["ClassificationResult"],
    fsm_state: ExecutionFsmState,
) -> ExecutionPolicy:
    """
    Final LLM routing authority.

    Priority:
      1. Product commerce cart stages → deterministic
      2. Payment flow active → deterministic
      3. Order awaiting number → deterministic
      4. Classifier low-confidence / fallback → short_circuit
      5. LLM only when no blocking FSM, cart/payment, or brain gate
    """
    _ = session  # reserved for future session-scoped policy extensions

    if _pcs_requires_deterministic(fsm_state.product_commerce_status):
        return EXECUTION_POLICY_DETERMINISTIC

    if fsm_state.payment_flow_active:
        return EXECUTION_POLICY_DETERMINISTIC

    if fsm_state.order_awaiting_order_number:
        return EXECUTION_POLICY_DETERMINISTIC

    if fsm_state.voice_stage == "completed":
        return EXECUTION_POLICY_DETERMINISTIC

    if fsm_state.support_handoff_active:
        return EXECUTION_POLICY_DETERMINISTIC

    if fsm_state.workflow_llm_blocked:
        return EXECUTION_POLICY_SHORT_CIRCUIT

    if fsm_state.brain_gate_active:
        return EXECUTION_POLICY_SHORT_CIRCUIT

    if fsm_state.product_commerce_fsm_active:
        return EXECUTION_POLICY_SHORT_CIRCUIT

    if _classifier_requests_short_circuit(classifier_result):
        return EXECUTION_POLICY_SHORT_CIRCUIT

    return EXECUTION_POLICY_LLM_ALLOWED


def policy_allows_llm(policy: ExecutionPolicy) -> bool:
    return policy == EXECUTION_POLICY_LLM_ALLOWED


def apply_execution_policy_to_plan(plan: object, policy: ExecutionPolicy) -> None:
    """Set orchestrator plan fields from resolved policy."""
    plan.execution_policy = policy  # type: ignore[attr-defined]
    plan.use_llm = policy_allows_llm(policy)


def assign_plan_fast_route_from_policy(
    plan: object,
    session: "SessionState",
    classifier_result: Optional["ClassificationResult"],
    *,
    turn_mode: str = "",
    policy: ExecutionPolicy,
    fsm_state: ExecutionFsmState,
) -> None:
    """Map resolved policy to orchestrator fast_route without duplicate gate checks."""
    if policy_allows_llm(policy):
        return

    from ..agent_runtime.workflow_isolation import (
        product_commerce_blocks_llm,
        product_commerce_orchestrator_route,
        product_commerce_status,
        support_handling_allowed,
    )
    from .fast_classifier import LOCK_PRODUCT_SEARCH_WORKFLOW

    locked = (classifier_result.locked_workflow if classifier_result else "") or ""
    if fsm_state.product_commerce_fsm_active or product_commerce_blocks_llm(session):
        plan.fast_route = (  # type: ignore[attr-defined]
            product_commerce_orchestrator_route(session) or "product_commerce_fsm"
        )
        plan.reason = f"product_commerce_{product_commerce_status(session)}"  # type: ignore[attr-defined]
    elif (
        fsm_state.support_handoff_active
        or support_handling_allowed(session, turn_mode, "")
    ) and locked != LOCK_PRODUCT_SEARCH_WORKFLOW:
        plan.fast_route = "support_handoff_workflow"  # type: ignore[attr-defined]
        plan.reason = "support_handoff_deterministic"  # type: ignore[attr-defined]
