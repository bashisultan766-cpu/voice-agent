"""
ConversationStateGraph — read-only derived state aggregator per turn.

Consolidates existing FSMs, cart memory, email capture, intent commitment,
and execution policy into one debuggable snapshot. Does not mutate session state
or replace any routing authority.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState
    from .execution_contract_versioning import ExecutionContractVersion

logger = logging.getLogger(__name__)

CONVERSATION_STATE_GRAPH_VERSION = "v1.0"


@dataclass(frozen=True)
class ProductCommerceSnapshot:
    """ProductCommerceState FSM + commerce flow sub-status."""

    status: str = "idle"
    derived_status: str = ""
    commerce_flow_status: str = "idle"
    awaiting_product_confirmation: bool = False
    ledger_confirmed_count: int = 0


@dataclass(frozen=True)
class PaymentFlowSnapshot:
    """Payment funnel FSM and checkout flags."""

    status: str = "idle"
    active: bool = False
    awaiting_payment_email: bool = False
    awaiting_payment_email_confirmation: bool = False
    payment_email_confirmed: bool = False
    payment_link_sent: bool = False
    payment_send_in_progress: bool = False
    checkout_url_present: bool = False
    payment_cart_confirmed: bool = False
    last_payment_attempt_status: str = ""


@dataclass(frozen=True)
class CartMemoryLineSnapshot:
    product_title: str = ""
    quantity: int = 0
    isbn: str = ""
    identifier: str = ""


@dataclass(frozen=True)
class CartMemorySnapshot:
    """Session CartMemory lines + ledger confirmed count."""

    item_count: int = 0
    items: tuple[CartMemoryLineSnapshot, ...] = ()
    ledger_confirmed_count: int = 0


@dataclass(frozen=True)
class EmailCaptureSnapshot:
    """Email capture / confirmation sub-state."""

    capture_mode: str = ""
    mode_active: bool = False
    has_pending_email: bool = False
    has_confirmed_email: bool = False
    pending_email_masked: str = ""
    confirmed_email_masked: str = ""
    awaiting_payment_email_confirmation: bool = False
    email_confidence: str = ""
    fragment_count: int = 0
    email_rejected_count: int = 0


@dataclass(frozen=True)
class IntentCommitmentSnapshot:
    """IntentCommitmentLayer — committed or pending turn classification."""

    committed: bool = False
    pending_turn_classification: bool = False
    locked_workflow: str = ""
    action: str = ""
    reason: str = ""
    execution_policy: str = ""
    active_workflow: str = ""
    skip_llm: bool = False
    product_commerce_status: str = ""


@dataclass(frozen=True)
class ExecutionPolicySnapshot:
    """ExecutionPolicyResolver FSM inputs + resolved policy when known."""

    policy: str = ""
    product_commerce_status: str = "idle"
    payment_flow_active: bool = False
    order_awaiting_order_number: bool = False
    voice_stage: str = "idle"
    brain_gate_active: bool = False
    support_handoff_active: bool = False
    product_commerce_fsm_active: bool = False
    active_workflow: str = ""
    workflow_llm_blocked: bool = False


@dataclass(frozen=True)
class ConversationStateGraph:
    """Unified read-only conversation snapshot for observability."""

    version: str = CONVERSATION_STATE_GRAPH_VERSION
    call_sid_short: str = ""
    turn_count: int = 0
    product_commerce: ProductCommerceSnapshot = field(
        default_factory=ProductCommerceSnapshot,
    )
    payment_flow: PaymentFlowSnapshot = field(default_factory=PaymentFlowSnapshot)
    cart_memory: CartMemorySnapshot = field(default_factory=CartMemorySnapshot)
    email_capture: EmailCaptureSnapshot = field(default_factory=EmailCaptureSnapshot)
    intent: IntentCommitmentSnapshot = field(default_factory=IntentCommitmentSnapshot)
    execution: ExecutionPolicySnapshot = field(default_factory=ExecutionPolicySnapshot)
    execution_contract: "ExecutionContractVersion" = field(
        default_factory=lambda: _default_execution_contract(),
    )

    def to_log_dict(self) -> dict[str, Any]:
        """Compact dict for structured logging — no raw PII."""
        payload = asdict(self)
        payload["execution_contract"] = self.execution_contract.to_dict()
        return payload


def _default_execution_contract() -> "ExecutionContractVersion":
    from .execution_contract_versioning import current_execution_contract

    return current_execution_contract()


def _mask_email_safe(email: str) -> str:
    from ..db.pii_masking import mask_email

    return mask_email(email) if email else ""


def _snapshot_cart_memory(session: "SessionState") -> CartMemorySnapshot:
    from .cart_memory import CartMemory

    raw = getattr(session, "cart_memory", None)
    lines: list[CartMemoryLineSnapshot] = []
    if isinstance(raw, CartMemory):
        for item in raw.items:
            lines.append(
                CartMemoryLineSnapshot(
                    product_title=item.product_title,
                    quantity=item.quantity,
                    isbn=item.isbn,
                    identifier=item.identifier,
                )
            )

    from ..cart.session import get_ledger

    ledger_count = get_ledger(session).confirmed_count()
    return CartMemorySnapshot(
        item_count=len(lines),
        items=tuple(lines),
        ledger_confirmed_count=ledger_count,
    )


def _snapshot_product_commerce(
    session: "SessionState",
    *,
    caller_text: str = "",
    turn_mode: str = "",
) -> ProductCommerceSnapshot:
    from ..agent_runtime.workflow_isolation import (
        derive_product_commerce_status,
        product_commerce_status,
    )
    from ..cart.session import get_ledger

    stored = product_commerce_status(session)
    derived = ""
    if caller_text or turn_mode:
        derived = derive_product_commerce_status(
            session, caller_text, turn_mode=turn_mode,
        )

    return ProductCommerceSnapshot(
        status=stored,
        derived_status=derived,
        commerce_flow_status=(
            getattr(session, "commerce_flow_status", "idle") or "idle"
        ),
        awaiting_product_confirmation=bool(
            getattr(session, "awaiting_product_confirmation", False),
        ),
        ledger_confirmed_count=get_ledger(session).confirmed_count(),
    )


def _snapshot_payment_flow(session: "SessionState") -> PaymentFlowSnapshot:
    from ..payment.payment_state_machine import in_payment_flow

    status = getattr(session, "payment_flow_status", "idle") or "idle"
    checkout_url = (
        getattr(session, "checkout_url", "")
        or getattr(session, "pending_checkout_url", "")
        or ""
    ).strip()

    return PaymentFlowSnapshot(
        status=status,
        active=in_payment_flow(session),
        awaiting_payment_email=bool(getattr(session, "awaiting_payment_email", False)),
        awaiting_payment_email_confirmation=bool(
            getattr(session, "awaiting_payment_email_confirmation", False),
        ),
        payment_email_confirmed=bool(getattr(session, "payment_email_confirmed", False)),
        payment_link_sent=bool(getattr(session, "payment_link_sent", False)),
        payment_send_in_progress=bool(getattr(session, "payment_send_in_progress", False)),
        checkout_url_present=bool(checkout_url),
        payment_cart_confirmed=bool(getattr(session, "payment_cart_confirmed", False)),
        last_payment_attempt_status=(
            getattr(session, "last_payment_attempt_status", "") or ""
        ),
    )


def _snapshot_email_capture(session: "SessionState") -> EmailCaptureSnapshot:
    from ..payment.email_state import email_capture_mode_active

    pending = (getattr(session, "pending_email", "") or "").strip()
    confirmed = (getattr(session, "confirmed_email", "") or "").strip()
    fragments = getattr(session, "pending_email_fragments", None) or []

    return EmailCaptureSnapshot(
        capture_mode=getattr(session, "email_capture_mode", "") or "",
        mode_active=email_capture_mode_active(session),
        has_pending_email=bool(pending),
        has_confirmed_email=bool(confirmed),
        pending_email_masked=_mask_email_safe(pending),
        confirmed_email_masked=_mask_email_safe(confirmed),
        awaiting_payment_email_confirmation=bool(
            getattr(session, "awaiting_payment_email_confirmation", False),
        ),
        email_confidence=getattr(session, "email_confidence", "") or "",
        fragment_count=len(fragments),
        email_rejected_count=int(getattr(session, "email_rejected_count", 0) or 0),
    )


def _snapshot_intent_commitment(session: "SessionState") -> IntentCommitmentSnapshot:
    committed = getattr(session, "committed_intent", None)
    pending = getattr(session, "_turn_classification", None)

    if committed is not None:
        return IntentCommitmentSnapshot(
            committed=True,
            pending_turn_classification=pending is not None,
            locked_workflow=getattr(committed, "locked_workflow", "") or "",
            action=getattr(committed, "action", "") or "",
            reason=getattr(committed, "reason", "") or "",
            execution_policy=getattr(committed, "execution_policy", "") or "",
            active_workflow=getattr(committed, "active_workflow", "") or "",
            skip_llm=bool(getattr(committed, "skip_llm", False)),
            product_commerce_status=getattr(committed, "product_commerce_status", "") or "",
        )

    if pending is not None:
        return IntentCommitmentSnapshot(
            committed=False,
            pending_turn_classification=True,
            locked_workflow=getattr(pending, "locked_workflow", "") or "",
            action=getattr(pending, "action", "") or "",
            reason=getattr(pending, "reason", "") or "",
            skip_llm=bool(getattr(pending, "skip_llm", False)),
        )

    return IntentCommitmentSnapshot()


def _snapshot_execution_policy(
    session: "SessionState",
    *,
    turn_mode: str = "",
    caller_text: str = "",
    active_workflow: str = "",
    execution_policy: str = "",
    voice_stage: str = "",
    workflow_llm_blocked: bool = False,
) -> ExecutionPolicySnapshot:
    from .execution_policy_resolver import (
        build_execution_fsm_state,
        probe_brain_gate_active,
    )

    voice_conv = getattr(session, "voice_conversation", None) or {}
    stage = (voice_stage or voice_conv.get("stage") or "idle").strip() or "idle"
    workflow = (active_workflow or "").strip()
    if not workflow:
        intent = getattr(session, "committed_intent", None)
        if intent is not None:
            workflow = getattr(intent, "active_workflow", "") or ""

    fsm = build_execution_fsm_state(
        session,
        turn_mode=turn_mode,
        voice_stage=stage,
        brain_gate_active=probe_brain_gate_active(
            session, caller_text, turn_mode=turn_mode,
        ) if caller_text else False,
        active_workflow=workflow,
        workflow_llm_blocked=workflow_llm_blocked,
    )

    policy = (execution_policy or "").strip()
    if not policy:
        intent = getattr(session, "committed_intent", None)
        if intent is not None:
            policy = getattr(intent, "execution_policy", "") or ""

    return ExecutionPolicySnapshot(
        policy=policy,
        product_commerce_status=fsm.product_commerce_status,
        payment_flow_active=fsm.payment_flow_active,
        order_awaiting_order_number=fsm.order_awaiting_order_number,
        voice_stage=fsm.voice_stage,
        brain_gate_active=fsm.brain_gate_active,
        support_handoff_active=fsm.support_handoff_active,
        product_commerce_fsm_active=fsm.product_commerce_fsm_active,
        active_workflow=fsm.active_workflow,
        workflow_llm_blocked=fsm.workflow_llm_blocked,
    )


def derive_conversation_state_graph(
    session: "SessionState",
    *,
    turn_mode: str = "",
    caller_text: str = "",
    active_workflow: str = "",
    execution_policy: str = "",
    voice_stage: str = "",
    workflow_llm_blocked: bool = False,
) -> ConversationStateGraph:
    """
    Build a read-only conversation snapshot from session state.

    Safe to call at any point in a turn for debugging / observability.
    Never writes to session.
    """
    from .execution_contract_versioning import current_execution_contract

    return ConversationStateGraph(
        call_sid_short=(getattr(session, "call_sid", "") or "")[:6],
        turn_count=int(getattr(session, "turn_count", 0) or 0),
        product_commerce=_snapshot_product_commerce(
            session, caller_text=caller_text, turn_mode=turn_mode,
        ),
        payment_flow=_snapshot_payment_flow(session),
        cart_memory=_snapshot_cart_memory(session),
        email_capture=_snapshot_email_capture(session),
        intent=_snapshot_intent_commitment(session),
        execution=_snapshot_execution_policy(
            session,
            turn_mode=turn_mode,
            caller_text=caller_text,
            active_workflow=active_workflow,
            execution_policy=execution_policy,
            voice_stage=voice_stage,
            workflow_llm_blocked=workflow_llm_blocked,
        ),
        execution_contract=current_execution_contract(),
    )


def log_conversation_state_graph(
    graph: ConversationStateGraph,
    *,
    source: str = "derive",
) -> None:
    """Emit one structured observability line — debugging only."""
    logger.info(
        "conversation_state_graph sid=%s source=%s turn=%s "
        "pcs=%s cfs=%s payment=%s cart_memory=%s ledger=%s "
        "email_capture=%s intent_committed=%s locked_workflow=%s "
        "execution_policy=%s active_workflow=%s brain_gate=%s",
        graph.call_sid_short or "-",
        source or "-",
        graph.turn_count,
        graph.product_commerce.status,
        graph.product_commerce.commerce_flow_status,
        graph.payment_flow.status,
        graph.cart_memory.item_count,
        graph.cart_memory.ledger_confirmed_count,
        graph.email_capture.mode_active,
        graph.intent.committed,
        graph.intent.locked_workflow or "-",
        graph.execution.policy or "-",
        graph.execution.active_workflow or "-",
        str(graph.execution.brain_gate_active).lower(),
    )
