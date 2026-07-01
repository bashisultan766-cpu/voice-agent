"""
Serialization helpers for ConversationReplayEngine.

Converts observability snapshots to/from plain dicts — no live LLM or classifier calls.
"""
from __future__ import annotations

from dataclasses import asdict, fields, is_dataclass
from typing import Any, TYPE_CHECKING

from .conversation_state_graph import (
    CartMemoryLineSnapshot,
    CartMemorySnapshot,
    ConversationStateGraph,
    EmailCaptureSnapshot,
    ExecutionPolicySnapshot,
    IntentCommitmentSnapshot,
    PaymentFlowSnapshot,
    ProductCommerceSnapshot,
    CONVERSATION_STATE_GRAPH_VERSION,
)
from .conversation_state_graph_diff import (
    CartDelta,
    ConversationStateGraphDiff,
    PaymentDelta,
    StateTransition,
    CONVERSATION_STATE_GRAPH_DIFF_VERSION,
)
from .execution_contract_versioning import (
    ExecutionContractVersion,
    contract_from_dict,
)
from .fast_classifier import ClassificationResult

if TYPE_CHECKING:
    from ..state.models import SessionState


SESSION_REPLAY_FIELDS: tuple[str, ...] = (
    "session_id",
    "call_sid",
    "from_number",
    "to_number",
    "turn_count",
    "product_commerce_status",
    "commerce_flow_status",
    "awaiting_product_confirmation",
    "payment_flow_status",
    "awaiting_payment_email",
    "awaiting_payment_email_confirmation",
    "payment_email_confirmed",
    "payment_link_sent",
    "payment_send_in_progress",
    "payment_cart_confirmed",
    "pending_checkout_url",
    "pending_draft_order_id",
    "checkout_url",
    "checkout_id",
    "last_payment_attempt_status",
    "email_capture_mode",
    "email_confidence",
    "email_rejected_count",
    "order_flow_status",
    "cart_items",
    "voice_conversation",
)


def classification_to_dict(result: ClassificationResult) -> dict[str, Any]:
    return asdict(result)


def classification_from_dict(data: dict[str, Any]) -> ClassificationResult:
    known = {f.name for f in fields(ClassificationResult)}
    return ClassificationResult(**{k: v for k, v in data.items() if k in known})


def intent_to_dict(intent: Any) -> dict[str, Any]:
    if intent is None:
        return {}
    if is_dataclass(intent):
        return asdict(intent)
    return {
        key: getattr(intent, key)
        for key in (
            "locked_workflow", "action", "reason", "is_product_search",
            "product_intent_detected", "is_order_lookup", "is_payment_flow",
            "skip_llm", "skip_brain", "intent_lock", "execution_policy",
            "active_workflow", "product_commerce_status", "turn_text", "turn_mode",
        )
        if hasattr(intent, key)
    }


def intent_from_dict(data: dict[str, Any]) -> Any:
    if not data:
        return None
    from .voice_commerce_runtime import Intent

    known = {f.name for f in fields(Intent)}
    return Intent(**{k: v for k, v in data.items() if k in known})


def graph_to_dict(graph: ConversationStateGraph) -> dict[str, Any]:
    return graph.to_log_dict()


def graph_from_dict(data: dict[str, Any]) -> ConversationStateGraph:
    cart_raw = data.get("cart_memory") or {}
    cart_items = cart_raw.get("items") or []
    return ConversationStateGraph(
        version=data.get("version", CONVERSATION_STATE_GRAPH_VERSION),
        call_sid_short=data.get("call_sid_short", ""),
        turn_count=int(data.get("turn_count", 0) or 0),
        product_commerce=ProductCommerceSnapshot(**(data.get("product_commerce") or {})),
        payment_flow=PaymentFlowSnapshot(**(data.get("payment_flow") or {})),
        cart_memory=CartMemorySnapshot(
            item_count=int(cart_raw.get("item_count", 0) or 0),
            items=tuple(
                CartMemoryLineSnapshot(**item) for item in cart_items
            ),
            ledger_confirmed_count=int(
                cart_raw.get("ledger_confirmed_count", 0) or 0,
            ),
        ),
        email_capture=EmailCaptureSnapshot(**(data.get("email_capture") or {})),
        intent=IntentCommitmentSnapshot(**(data.get("intent") or {})),
        execution=ExecutionPolicySnapshot(**(data.get("execution") or {})),
        execution_contract=contract_from_dict(data.get("execution_contract")),
    )


def diff_to_dict(diff: ConversationStateGraphDiff) -> dict[str, Any]:
    return diff.to_log_dict()


def diff_from_dict(data: dict[str, Any]) -> ConversationStateGraphDiff:
    cart_raw = data.get("cart_delta") or {}
    payment_raw = data.get("payment_delta") or {}
    transitions = data.get("state_transitions") or []
    return ConversationStateGraphDiff(
        version=data.get("version", CONVERSATION_STATE_GRAPH_DIFF_VERSION),
        added_fields=tuple(data.get("added_fields") or ()),
        removed_fields=tuple(data.get("removed_fields") or ()),
        changed_fields=tuple(
            tuple(row) for row in (data.get("changed_fields") or ())
        ),
        state_transitions=tuple(
            StateTransition(**row) for row in transitions
        ),
        cart_delta=CartDelta(
            item_count_delta=int(cart_raw.get("item_count_delta", 0) or 0),
            ledger_confirmed_delta=int(
                cart_raw.get("ledger_confirmed_delta", 0) or 0,
            ),
            added_items=tuple(
                CartMemoryLineSnapshot(**item)
                for item in (cart_raw.get("added_items") or [])
            ),
            removed_items=tuple(
                CartMemoryLineSnapshot(**item)
                for item in (cart_raw.get("removed_items") or [])
            ),
            changed_quantities=tuple(
                tuple(row) for row in (cart_raw.get("changed_quantities") or ())
            ),
        ),
        payment_delta=PaymentDelta(
            status_changed=bool(payment_raw.get("status_changed", False)),
            previous_status=payment_raw.get("previous_status", "") or "",
            current_status=payment_raw.get("current_status", "") or "",
            flag_changes=tuple(
                tuple(row) for row in (payment_raw.get("flag_changes") or ())
            ),
        ),
    )


def capture_session_replay_snapshot(session: "SessionState") -> dict[str, Any]:
    """Read-only masked session fields for replay reconstruction."""
    from ..db.pii_masking import mask_email

    snapshot: dict[str, Any] = {}
    for key in SESSION_REPLAY_FIELDS:
        value = getattr(session, key, None)
        if value is not None:
            snapshot[key] = value

    pending = (getattr(session, "pending_email", "") or "").strip()
    confirmed = (getattr(session, "confirmed_email", "") or "").strip()
    if pending:
        snapshot["pending_email_masked"] = mask_email(pending)
        snapshot["has_pending_email"] = True
    if confirmed:
        snapshot["confirmed_email_masked"] = mask_email(confirmed)
        snapshot["has_confirmed_email"] = True

    raw_cart = getattr(session, "cart_memory", None)
    if raw_cart is not None and hasattr(raw_cart, "to_dict_list"):
        snapshot["cart_memory_items"] = raw_cart.to_dict_list()

    intent = getattr(session, "committed_intent", None)
    if intent is not None:
        snapshot["committed_intent"] = intent_to_dict(intent)

    return snapshot


def session_from_replay_snapshot(data: dict[str, Any]) -> "SessionState":
    from ..state.models import SessionState
    from .cart_memory import CartMemory, CartMemoryItem

    session = SessionState(
        session_id=str(data.get("session_id", "replay")),
        call_sid=str(data.get("call_sid", "CAreplay")),
        from_number=str(data.get("from_number", "+0")),
        to_number=str(data.get("to_number", "+0")),
    )
    for key in SESSION_REPLAY_FIELDS:
        if key in data:
            setattr(session, key, data[key])

    if data.get("has_pending_email"):
        session.pending_email = "__replay_masked__"
    if data.get("has_confirmed_email"):
        session.confirmed_email = "__replay_masked__"

    for item in data.get("cart_memory_items") or []:
        if not isinstance(getattr(session, "cart_memory", None), CartMemory):
            session.cart_memory = CartMemory()
        session.cart_memory.add_to_cart(CartMemoryItem.from_mapping(item))

    intent_data = data.get("committed_intent")
    if intent_data:
        session.committed_intent = intent_from_dict(intent_data)

    return session
