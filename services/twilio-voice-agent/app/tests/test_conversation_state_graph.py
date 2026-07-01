"""ConversationStateGraph — read-only derived state aggregator."""
from __future__ import annotations

from unittest.mock import patch

from app.runtime.cart_memory import CartMemory, CartMemoryItem
from app.runtime.conversation_state_graph import (
    CONVERSATION_STATE_GRAPH_VERSION,
    derive_conversation_state_graph,
    log_conversation_state_graph,
)
from app.runtime.execution_policy_resolver import EXECUTION_POLICY_SHORT_CIRCUIT
from app.runtime.fast_classifier import LOCK_PRODUCT_SEARCH_WORKFLOW, ClassificationResult
from app.runtime.voice_commerce_runtime import commit_intent
from app.agent_runtime.workflow_isolation import PCS_DISCOVERY
from app.payment.email_state import EMAIL_CAPTURE_MODE, enter_email_capture_mode
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="csg",
        call_sid="CAcsg123456",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


def test_derive_is_read_only_snapshot():
    session = _session(
        product_commerce_status=PCS_DISCOVERY,
        commerce_flow_status="awaiting_book_confirm",
        payment_flow_status="awaiting_email",
        turn_count=3,
    )
    session.cart_memory = CartMemory(
        items=[CartMemoryItem(product_title="Book A", quantity=2, isbn="978123")],
    )
    enter_email_capture_mode(session)
    session.pending_email = "user@example.com"

    before_cart_id = id(session.cart_memory)
    before_pending = session.pending_email

    graph = derive_conversation_state_graph(session, caller_text="find a book")

    assert graph.version == CONVERSATION_STATE_GRAPH_VERSION
    assert graph.call_sid_short == "CAcsg1"
    assert graph.turn_count == 3
    assert graph.product_commerce.status == PCS_DISCOVERY
    assert graph.product_commerce.commerce_flow_status == "awaiting_book_confirm"
    assert graph.payment_flow.status == "awaiting_email"
    assert graph.payment_flow.active is True
    assert graph.cart_memory.item_count == 1
    assert graph.cart_memory.items[0].product_title == "Book A"
    assert graph.email_capture.mode_active is True
    assert graph.email_capture.has_pending_email is True
    assert "@" in graph.email_capture.pending_email_masked
    assert graph.email_capture.pending_email_masked != "user@example.com"

    assert id(session.cart_memory) == before_cart_id
    assert session.pending_email == before_pending


def test_derive_reflects_intent_commitment():
    session = _session()
    from app.runtime.execution_policy_resolver import ExecutionFsmState

    clf = ClassificationResult(
        locked_workflow=LOCK_PRODUCT_SEARCH_WORKFLOW,
        skip_llm=True,
        is_product_search=True,
    )
    commit_intent(
        session,
        clf,
        ExecutionFsmState(product_commerce_status=PCS_DISCOVERY),
        active_workflow="product",
        execution_policy=EXECUTION_POLICY_SHORT_CIRCUIT,
        turn_text="find books",
    )

    graph = derive_conversation_state_graph(
        session,
        active_workflow="product",
        execution_policy=EXECUTION_POLICY_SHORT_CIRCUIT,
    )

    assert graph.intent.committed is True
    assert graph.intent.locked_workflow == LOCK_PRODUCT_SEARCH_WORKFLOW
    assert graph.intent.execution_policy == EXECUTION_POLICY_SHORT_CIRCUIT
    assert graph.intent.skip_llm is True
    assert graph.execution.policy == EXECUTION_POLICY_SHORT_CIRCUIT
    assert graph.execution.active_workflow == "product"


def test_log_conversation_state_graph_emits_observability_line():
    session = _session()
    graph = derive_conversation_state_graph(session)
    with patch("app.runtime.conversation_state_graph.logger") as mock_log:
        log_conversation_state_graph(graph, source="test")
        mock_log.info.assert_called_once()
        assert "conversation_state_graph" in str(mock_log.info.call_args)
