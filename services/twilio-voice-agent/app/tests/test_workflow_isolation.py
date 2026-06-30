"""Workflow isolation — order, product, payment, support must not cross-interfere."""
from __future__ import annotations

from app.agent_runtime.commerce_flow_state import (
    STATUS_AWAITING_EMAIL_COLLECTION,
    STATUS_AWAITING_QUANTITY,
    advance_commerce_state_silent,
    commerce_blocks_open_commerce,
)
from app.agent_runtime.isbn_short_circuit import payment_email_context_active
from app.agent_runtime.order_flow_state import (
    STATUS_AWAITING_ORDER_NUMBER,
    STATUS_IDLE,
)
from app.agent_runtime.voice_workflows import (
    ORDER_WORKFLOW,
    PRODUCT_SEARCH_WORKFLOW,
    SUPPORT_HANDOFF_WORKFLOW,
    WORKFLOW_COMMERCE,
    WORKFLOW_IDLE,
    WORKFLOW_PAYMENT,
)
from app.agent_runtime.workflow_isolation import (
    commerce_handling_allowed,
    commerce_silent_advance_allowed,
    isolate_workflow_buffers,
    order_handling_allowed,
    payment_handling_allowed,
    payment_workflow_active,
    product_handling_allowed,
    resolve_primary_workflow,
    support_handling_allowed,
)
from app.payment.payment_state_machine import (
    payment_email_turn_priority,
    support_email_turn_priority,
)
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="wf",
        call_sid="CAwf000000000000000000000000000001",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


class TestWorkflowPriority:
    def test_support_over_payment(self):
        session = _session(
            awaiting_not_found_escalation_email=True,
            awaiting_payment_email=True,
            payment_flow_status="awaiting_email",
        )
        assert resolve_primary_workflow(session, "email", "j at gmail dot com") == SUPPORT_HANDOFF_WORKFLOW
        assert support_handling_allowed(session, "email", "j at gmail dot com")
        assert not payment_handling_allowed(session, "email", "j at gmail dot com")

    def test_payment_over_order_collection(self):
        session = _session(
            order_flow_status=STATUS_AWAITING_ORDER_NUMBER,
            payment_flow_status="awaiting_email",
            awaiting_payment_email=True,
        )
        assert resolve_primary_workflow(session, "email", "yes") == WORKFLOW_PAYMENT
        assert not order_handling_allowed(session, "order", "63482")

    def test_order_collection_blocks_product(self):
        session = _session(order_flow_status=STATUS_AWAITING_ORDER_NUMBER)
        assert resolve_primary_workflow(session, "", "9780553582024") == ORDER_WORKFLOW
        assert not product_handling_allowed(session, "", "9780553582024")
        assert payment_email_context_active(session, "")

    def test_commerce_cart_blocks_order_passive_followup(self):
        session = _session(
            commerce_flow_status=STATUS_AWAITING_QUANTITY,
            commerce_pending_candidate={"title": "Book", "variant_id": "v1"},
            last_order_number="CA63482",
            order_last_voice_reply="Your order is shipped.",
        )
        assert resolve_primary_workflow(session, "", "what was the card") == WORKFLOW_COMMERCE
        assert not order_handling_allowed(session, "", "what was the card")

    def test_idle_order_context_allows_card_followup(self):
        session = _session(
            last_order_number="CA63482",
            order_last_voice_reply="Your order is shipped.",
        )
        assert resolve_primary_workflow(session, "", "what was the card") == WORKFLOW_IDLE
        assert order_handling_allowed(session, "", "what was the card")

    def test_buy_intent_not_hijacked_by_order_context(self):
        session = _session(
            last_order_number="CA63482",
            order_last_voice_reply="Your order is shipped.",
        )
        assert not order_handling_allowed(session, "", "how do I buy a book")

    def test_product_isbn_on_idle(self):
        session = _session()
        assert resolve_primary_workflow(session, "isbn", "9780553582024") == PRODUCT_SEARCH_WORKFLOW
        assert product_handling_allowed(session, "isbn", "9780553582024")


class TestWorkflowBuffers:
    def test_payment_clears_isbn_buffer(self):
        session = _session(
            pending_isbn_buffer="978055",
            payment_flow_status="awaiting_email",
            awaiting_payment_email=True,
        )
        wf = isolate_workflow_buffers(session, "email", "j at gmail dot com")
        assert wf == WORKFLOW_PAYMENT
        assert session.pending_isbn_buffer == ""

    def test_order_collection_clears_isbn_buffer(self):
        session = _session(
            pending_isbn_buffer="978055",
            order_flow_status=STATUS_AWAITING_ORDER_NUMBER,
        )
        wf = isolate_workflow_buffers(session, "order", "63482")
        assert wf == ORDER_WORKFLOW
        assert session.pending_isbn_buffer == ""

    def test_isbn_after_order_lookup_does_not_crash(self):
        """Regression CA672f — STATUS_IDLE NameError silenced ISBN product hunt."""
        session = _session(
            last_order_number="47999",
            order_last_voice_reply="I found your order.",
            order_flow_status=STATUS_IDLE,
        )
        wf = isolate_workflow_buffers(session, "isbn", "9781544503547.")
        assert wf == PRODUCT_SEARCH_WORKFLOW
        assert session.order_flow_status == STATUS_IDLE


class TestPaymentSupportSplit:
    def test_support_email_priority_independent(self):
        session = _session(awaiting_not_found_escalation_email=True)
        assert support_email_turn_priority(session)
        assert not payment_email_turn_priority(session)

    def test_payment_email_priority_without_support(self):
        session = _session(awaiting_payment_email=True, payment_flow_status="awaiting_email")
        assert payment_email_turn_priority(session, "email")


class TestCommerceSilentAdvance:
    def test_blocked_during_email_collection(self):
        session = _session(
            commerce_flow_status=STATUS_AWAITING_EMAIL_COLLECTION,
            awaiting_payment_email=True,
            payment_flow_status="awaiting_email",
        )
        assert not commerce_silent_advance_allowed(session, "email", "yes")

    def test_quantity_step_allowed_when_stale_payment_flags(self):
        """Cart building must win over premature payment_flow_status from old builds."""
        session = _session(
            commerce_flow_status=STATUS_AWAITING_QUANTITY,
            commerce_pending_candidate={"title": "Book", "variant_id": "v1"},
            payment_flow_status="awaiting_email",
            awaiting_payment_email=True,
        )
        assert commerce_silent_advance_allowed(session, "", "I need 2 copies")
        advance_commerce_state_silent(session, "I need 2 copies")
        assert session.commerce_allow_add

    def test_allowed_during_commerce(self):
        session = _session(
            commerce_flow_status=STATUS_AWAITING_QUANTITY,
            commerce_pending_candidate={"title": "Book", "variant_id": "v1"},
        )
        assert commerce_silent_advance_allowed(session, "", "Yes.")
        advance_commerce_state_silent(session, "Yes.")
        assert session.commerce_pending_quantity == 1

    def test_commerce_blocks_when_support_active(self):
        session = _session(awaiting_not_found_escalation_email=True)
        assert commerce_blocks_open_commerce(session)
        assert not commerce_handling_allowed(session, "", "add another book")

    def test_commerce_blocks_when_email_collection(self):
        session = _session(commerce_flow_status=STATUS_AWAITING_EMAIL_COLLECTION)
        assert commerce_blocks_open_commerce(session)
