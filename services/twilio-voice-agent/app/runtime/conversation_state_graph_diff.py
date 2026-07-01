"""
ConversationStateGraphDiff — compare two graph snapshots for observability.

Read-only: never mutates FSMs, session commerce state, or execution routing.
Observability cache attributes on session are used only to chain turn-to-turn diffs.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field, fields, is_dataclass
from typing import Any, TYPE_CHECKING

from .conversation_state_graph import (
    CartMemoryLineSnapshot,
    CartMemorySnapshot,
    ConversationStateGraph,
    PaymentFlowSnapshot,
    derive_conversation_state_graph,
)

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

CONVERSATION_STATE_GRAPH_DIFF_VERSION = "v1.0"

OBS_CONVERSATION_STATE_GRAPH_PREV_ATTR = "_obs_conversation_state_graph_prev"
OBS_CONVERSATION_STATE_GRAPH_PENDING_ATTR = "_obs_conversation_state_graph_pending"

_FSM_TRANSITION_SPECS: tuple[tuple[str, str, str], ...] = (
    ("product_commerce", "status", "product_commerce"),
    ("product_commerce", "commerce_flow_status", "commerce_flow"),
    ("product_commerce", "derived_status", "product_commerce_derived"),
    ("payment_flow", "status", "payment_flow"),
    ("execution", "policy", "execution_policy"),
    ("execution", "voice_stage", "voice_stage"),
    ("intent", "locked_workflow", "intent_workflow"),
    ("execution", "active_workflow", "active_workflow"),
)

_PAYMENT_FLAG_FIELDS: tuple[str, ...] = (
    "active",
    "awaiting_payment_email",
    "awaiting_payment_email_confirmation",
    "payment_email_confirmed",
    "payment_link_sent",
    "payment_send_in_progress",
    "checkout_url_present",
    "payment_cart_confirmed",
)


@dataclass(frozen=True)
class StateTransition:
    domain: str
    field: str
    previous: str
    current: str


@dataclass(frozen=True)
class CartDelta:
    item_count_delta: int = 0
    ledger_confirmed_delta: int = 0
    added_items: tuple[CartMemoryLineSnapshot, ...] = ()
    removed_items: tuple[CartMemoryLineSnapshot, ...] = ()
    changed_quantities: tuple[tuple[str, int, int], ...] = ()


@dataclass(frozen=True)
class PaymentDelta:
    status_changed: bool = False
    previous_status: str = ""
    current_status: str = ""
    flag_changes: tuple[tuple[str, bool, bool], ...] = ()


@dataclass(frozen=True)
class ConversationStateGraphDiff:
    version: str = CONVERSATION_STATE_GRAPH_DIFF_VERSION
    added_fields: tuple[str, ...] = ()
    removed_fields: tuple[str, ...] = ()
    changed_fields: tuple[tuple[str, Any, Any], ...] = ()
    state_transitions: tuple[StateTransition, ...] = ()
    cart_delta: CartDelta = field(default_factory=CartDelta)
    payment_delta: PaymentDelta = field(default_factory=PaymentDelta)

    @property
    def has_changes(self) -> bool:
        return bool(
            self.added_fields
            or self.removed_fields
            or self.changed_fields
            or self.state_transitions
            or self.cart_delta.added_items
            or self.cart_delta.removed_items
            or self.cart_delta.changed_quantities
            or self.cart_delta.item_count_delta
            or self.cart_delta.ledger_confirmed_delta
            or self.payment_delta.status_changed
            or self.payment_delta.flag_changes
        )

    def to_log_dict(self) -> dict[str, Any]:
        return asdict(self)


def _is_empty(value: Any) -> bool:
    if value is None or value is False or value == ():
        return True
    if isinstance(value, str):
        return not value.strip()
    return False


def _get_nested(obj: Any, section: str, attr: str) -> Any:
    block = getattr(obj, section, None)
    if block is None:
        return None
    return getattr(block, attr, None)


def _flatten_graph(graph: ConversationStateGraph) -> dict[str, Any]:
    """Scalar dot-paths for diff — cart line items handled via cart_delta."""
    flat: dict[str, Any] = {}

    def walk(prefix: str, value: Any) -> None:
        if is_dataclass(value):
            for child in fields(value):
                path = f"{prefix}.{child.name}" if prefix else child.name
                if path == "cart_memory.items":
                    continue
                walk(path, getattr(value, child.name))
            return
        flat[prefix] = value

    walk("", graph)
    return flat


def _line_key(line: CartMemoryLineSnapshot) -> str:
    for key in (line.isbn, line.identifier, line.product_title):
        if key:
            return key.lower()
    return ""


def _compute_cart_delta(
    prev: CartMemorySnapshot,
    current: CartMemorySnapshot,
) -> CartDelta:
    prev_map = {_line_key(item): item for item in prev.items if _line_key(item)}
    curr_map = {_line_key(item): item for item in current.items if _line_key(item)}

    added = tuple(curr_map[key] for key in curr_map if key not in prev_map)
    removed = tuple(prev_map[key] for key in prev_map if key not in curr_map)
    changed_quantities: list[tuple[str, int, int]] = []
    for key in prev_map:
        if key in curr_map and prev_map[key].quantity != curr_map[key].quantity:
            changed_quantities.append(
                (key, prev_map[key].quantity, curr_map[key].quantity),
            )

    return CartDelta(
        item_count_delta=current.item_count - prev.item_count,
        ledger_confirmed_delta=current.ledger_confirmed_count - prev.ledger_confirmed_count,
        added_items=added,
        removed_items=removed,
        changed_quantities=tuple(changed_quantities),
    )


def _compute_payment_delta(
    prev: PaymentFlowSnapshot,
    current: PaymentFlowSnapshot,
) -> PaymentDelta:
    flag_changes: list[tuple[str, bool, bool]] = []
    for name in _PAYMENT_FLAG_FIELDS:
        old_val = bool(getattr(prev, name))
        new_val = bool(getattr(current, name))
        if old_val != new_val:
            flag_changes.append((name, old_val, new_val))

    return PaymentDelta(
        status_changed=prev.status != current.status,
        previous_status=prev.status,
        current_status=current.status,
        flag_changes=tuple(flag_changes),
    )


def _compute_state_transitions(
    prev: ConversationStateGraph,
    current: ConversationStateGraph,
) -> tuple[StateTransition, ...]:
    transitions: list[StateTransition] = []
    for section, attr, domain in _FSM_TRANSITION_SPECS:
        old_val = _get_nested(prev, section, attr)
        new_val = _get_nested(current, section, attr)
        old_str = str(old_val or "")
        new_str = str(new_val or "")
        if old_str != new_str:
            transitions.append(
                StateTransition(
                    domain=domain,
                    field=attr,
                    previous=old_str or "-",
                    current=new_str or "-",
                ),
            )
    return tuple(transitions)


def _compute_scalar_field_diff(
    prev_flat: dict[str, Any],
    current_flat: dict[str, Any],
) -> tuple[tuple[str, ...], tuple[str, ...], tuple[tuple[str, Any, Any], ...]]:
    all_paths = sorted(set(prev_flat) | set(current_flat))
    added: list[str] = []
    removed: list[str] = []
    changed: list[tuple[str, Any, Any]] = []

    for path in all_paths:
        old_val = prev_flat.get(path)
        new_val = current_flat.get(path)
        if old_val == new_val:
            continue
        if _is_empty(old_val) and not _is_empty(new_val):
            added.append(path)
        elif not _is_empty(old_val) and _is_empty(new_val):
            removed.append(path)
        else:
            changed.append((path, old_val, new_val))

    return tuple(added), tuple(removed), tuple(changed)


def diff_conversation_state_graph(
    prev: ConversationStateGraph,
    current: ConversationStateGraph,
) -> ConversationStateGraphDiff:
    """
    Compare two ConversationStateGraph snapshots.

    Pure function — no session or FSM side effects.
    """
    added, removed, changed = _compute_scalar_field_diff(
        _flatten_graph(prev),
        _flatten_graph(current),
    )
    return ConversationStateGraphDiff(
        added_fields=added,
        removed_fields=removed,
        changed_fields=changed,
        state_transitions=_compute_state_transitions(prev, current),
        cart_delta=_compute_cart_delta(prev.cart_memory, current.cart_memory),
        payment_delta=_compute_payment_delta(prev.payment_flow, current.payment_flow),
    )


def _derive_observability_graph(session: "SessionState") -> ConversationStateGraph:
    """Derive current graph from session using committed-intent hints when present."""
    intent = getattr(session, "committed_intent", None)
    return derive_conversation_state_graph(
        session,
        turn_mode=getattr(intent, "turn_mode", "") or "" if intent else "",
        caller_text=getattr(intent, "turn_text", "") or "" if intent else "",
        active_workflow=getattr(intent, "active_workflow", "") or "" if intent else "",
        execution_policy=getattr(intent, "execution_policy", "") or "" if intent else "",
    )


def _resolve_current_graph(session: "SessionState") -> ConversationStateGraph:
    pending = getattr(session, OBS_CONVERSATION_STATE_GRAPH_PENDING_ATTR, None)
    if isinstance(pending, ConversationStateGraph):
        return pending
    return _derive_observability_graph(session)


def _emit_diff_log(diff: ConversationStateGraphDiff, session: "SessionState") -> None:
    sid = (getattr(session, "call_sid", "") or "")[:6]
    transitions = ",".join(
        f"{t.domain}:{t.previous}->{t.current}" for t in diff.state_transitions
    ) or "-"
    logger.info(
        "conversation_state_graph_diff sid=%s added=%s removed=%s changed=%s "
        "state_transitions=%s cart_item_delta=%s payment_status=%s->%s",
        sid or "-",
        len(diff.added_fields),
        len(diff.removed_fields),
        len(diff.changed_fields),
        transitions,
        diff.cart_delta.item_count_delta,
        diff.payment_delta.previous_status or "-",
        diff.payment_delta.current_status or "-",
    )


def log_conversation_state_graph_diff(
    session: "SessionState",
) -> ConversationStateGraphDiff | None:
    """
    Log structured diff vs the previous observability snapshot for this session.

    Set ``OBS_CONVERSATION_STATE_GRAPH_PENDING_ATTR`` on the session to the freshly
    derived graph before calling (e.g. from handle_turn) for an accurate snapshot.
    Updates only observability cache attributes — never FSM or routing state.
    """
    prev = getattr(session, OBS_CONVERSATION_STATE_GRAPH_PREV_ATTR, None)
    current = _resolve_current_graph(session)

    result: ConversationStateGraphDiff | None = None
    if isinstance(prev, ConversationStateGraph):
        result = diff_conversation_state_graph(prev, current)
        if result.has_changes:
            _emit_diff_log(result, session)

    setattr(session, OBS_CONVERSATION_STATE_GRAPH_PREV_ATTR, current)
    if hasattr(session, OBS_CONVERSATION_STATE_GRAPH_PENDING_ATTR):
        delattr(session, OBS_CONVERSATION_STATE_GRAPH_PENDING_ATTR)

    return result
