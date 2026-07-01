"""ConversationStateGraphDiff — structured snapshot comparison."""
from __future__ import annotations

from unittest.mock import patch

from app.runtime.cart_memory import CartMemory, CartMemoryItem
from app.runtime.conversation_state_graph import (
    CartMemoryLineSnapshot,
    CartMemorySnapshot,
    ConversationStateGraph,
    derive_conversation_state_graph,
)
from app.runtime.conversation_state_graph_diff import (
    CONVERSATION_STATE_GRAPH_DIFF_VERSION,
    OBS_CONVERSATION_STATE_GRAPH_PREV_ATTR,
    OBS_CONVERSATION_STATE_GRAPH_PENDING_ATTR,
    diff_conversation_state_graph,
    log_conversation_state_graph_diff,
)
from app.agent_runtime.workflow_isolation import PCS_DISCOVERY, PCS_CART_BUILDING
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="csgd",
        call_sid="CAcsgd12345",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


def test_diff_conversation_state_graph_detects_fsm_transitions():
    prev = derive_conversation_state_graph(
        _session(product_commerce_status="idle", payment_flow_status="idle"),
    )
    current = derive_conversation_state_graph(
        _session(
            product_commerce_status=PCS_DISCOVERY,
            commerce_flow_status="awaiting_book_confirm",
            payment_flow_status="awaiting_email",
        ),
    )

    diff = diff_conversation_state_graph(prev, current)

    assert diff.version == CONVERSATION_STATE_GRAPH_DIFF_VERSION
    domains = {t.domain for t in diff.state_transitions}
    assert "product_commerce" in domains
    assert "commerce_flow" in domains
    assert "payment_flow" in domains
    assert diff.payment_delta.status_changed is True
    assert diff.payment_delta.previous_status == "idle"
    assert diff.payment_delta.current_status == "awaiting_email"
    assert diff.has_changes is True


def test_diff_cart_delta_tracks_items_and_quantities():
    prev = ConversationStateGraph(
        cart_memory=CartMemorySnapshot(
            item_count=1,
            items=(
                CartMemoryLineSnapshot(
                    product_title="Book A", quantity=1, isbn="978111",
                ),
            ),
            ledger_confirmed_count=1,
        ),
    )
    current = ConversationStateGraph(
        cart_memory=CartMemorySnapshot(
            item_count=2,
            items=(
                CartMemoryLineSnapshot(
                    product_title="Book A", quantity=3, isbn="978111",
                ),
                CartMemoryLineSnapshot(
                    product_title="Book B", quantity=1, isbn="978222",
                ),
            ),
            ledger_confirmed_count=2,
        ),
    )

    diff = diff_conversation_state_graph(prev, current)

    assert diff.cart_delta.item_count_delta == 1
    assert diff.cart_delta.ledger_confirmed_delta == 1
    assert len(diff.cart_delta.added_items) == 1
    assert diff.cart_delta.added_items[0].isbn == "978222"
    assert diff.cart_delta.changed_quantities == (("978111", 1, 3),)


def test_diff_scalar_added_removed_changed_fields():
    prev = derive_conversation_state_graph(_session(turn_count=1))
    current = derive_conversation_state_graph(
        _session(turn_count=2, product_commerce_status=PCS_CART_BUILDING),
    )

    diff = diff_conversation_state_graph(prev, current)

    changed_paths = {path for path, _, _ in diff.changed_fields}
    assert "turn_count" in changed_paths
    assert "product_commerce.status" in changed_paths


def test_log_conversation_state_graph_diff_first_turn_no_log():
    session = _session()
    current = derive_conversation_state_graph(session)
    setattr(session, OBS_CONVERSATION_STATE_GRAPH_PENDING_ATTR, current)

    with patch("app.runtime.conversation_state_graph_diff.logger") as mock_log:
        result = log_conversation_state_graph_diff(session)
        mock_log.info.assert_not_called()

    assert result is None
    assert isinstance(
        getattr(session, OBS_CONVERSATION_STATE_GRAPH_PREV_ATTR),
        ConversationStateGraph,
    )


def test_log_conversation_state_graph_diff_logs_on_second_turn():
    session = _session(product_commerce_status="idle")
    first = derive_conversation_state_graph(session)
    setattr(session, OBS_CONVERSATION_STATE_GRAPH_PREV_ATTR, first)

    session.product_commerce_status = PCS_DISCOVERY
    second = derive_conversation_state_graph(session)
    setattr(session, OBS_CONVERSATION_STATE_GRAPH_PENDING_ATTR, second)

    with patch("app.runtime.conversation_state_graph_diff.logger") as mock_log:
        diff = log_conversation_state_graph_diff(session)
        mock_log.info.assert_called_once()
        assert "conversation_state_graph_diff" in str(mock_log.info.call_args)

    assert diff is not None
    assert diff.has_changes is True
    assert any(t.domain == "product_commerce" for t in diff.state_transitions)


def test_diff_does_not_mutate_session_commerce_state():
    session = _session()
    session.cart_memory = CartMemory(
        items=[CartMemoryItem(product_title="Book", quantity=1)],
    )
    before_items = list(session.cart_memory.items)

    prev = derive_conversation_state_graph(session)
    session.cart_memory.add_to_cart(
        CartMemoryItem(product_title="Other", quantity=2, isbn="999"),
    )
    current = derive_conversation_state_graph(session)

    diff_conversation_state_graph(prev, current)

    assert len(session.cart_memory.items) == 2
    assert session.cart_memory.items[0].product_title == before_items[0].product_title
