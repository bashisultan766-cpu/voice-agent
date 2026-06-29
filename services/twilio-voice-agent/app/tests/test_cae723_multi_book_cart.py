"""Regression CAe723 — multi-book cart must not flip to payment after first add."""
from __future__ import annotations

from app.agent_runtime.commerce_flow_state import (
    COMMERCE_FLOW_VERSION,
    STATUS_AWAITING_ANOTHER_BOOK,
    STATUS_AWAITING_QUANTITY,
    add_staged_book_to_cart,
    commerce_cart_building_active,
    process_commerce_turn,
    reset_payment_preflight,
    stage_product_candidate,
)
from app.agent_runtime.workflow_isolation import (
    WORKFLOW_COMMERCE,
    WORKFLOW_PRODUCT,
    payment_workflow_active,
    product_handling_allowed,
    resolve_primary_workflow,
)
from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
from app.dialogue.call_closure import process_call_closure_turn
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="cae723",
        call_sid="CAe723b9c1cd0b6dc6202a1e67f22ec5cc",
        from_number="+1",
        to_number="+2",
    )
    base.update(kwargs)
    return SessionState(**base)


def _stage_healthy_adult(session: SessionState) -> None:
    stage_product_candidate(session, {
        "title": "#HealthyAdult",
        "isbn": "9781544503547",
        "variant_id": "v-healthy",
        "price": "18.00",
        "available": True,
    })


class TestVersions:
    def test_commerce_flow_version(self):
        assert COMMERCE_FLOW_VERSION == "v4.49"


class TestPaymentDoesNotHijackCartBuilding:
    def test_first_book_add_does_not_start_payment(self):
        session = _session()
        _stage_healthy_adult(session)
        add_staged_book_to_cart(session, quantity=20)
        assert session.commerce_flow_status == STATUS_AWAITING_ANOTHER_BOOK
        assert session.payment_flow_status in ("idle", "")
        assert not getattr(session, "awaiting_payment_email", False)
        assert commerce_cart_building_active(session)
        assert not payment_workflow_active(session)
        assert resolve_primary_workflow(session, "", "I want another book") == WORKFLOW_COMMERCE

    def test_another_book_stays_commerce_not_payment(self):
        session = _session(payment_flow_status="awaiting_email")
        session.commerce_flow_status = STATUS_AWAITING_ANOTHER_BOOK
        reset_payment_preflight(session)
        assert session.payment_flow_status == "idle"
        hint = process_commerce_turn(session, "Yes. I want another book.")
        assert hint.force_reply
        assert product_handling_allowed(session, "isbn", "9780062511409")
        assert resolve_primary_workflow(session, "isbn", "9780062511409") == WORKFLOW_PRODUCT

    def test_quantity_after_isbn_stays_commerce(self):
        session = _session()
        stage_product_candidate(session, {
            "title": "The Alchemist",
            "isbn": "9780062511409",
            "variant_id": "v-alch",
            "price": "12.00",
            "available": True,
        })
        assert session.commerce_flow_status == STATUS_AWAITING_QUANTITY
        assert resolve_primary_workflow(session, "", "Yes. I need 50 copy of this.") == WORKFLOW_COMMERCE
        hint = process_commerce_turn(session, "Yes. I need 50 copy of this.")
        assert hint.book_added
        assert get_ledger(session).confirmed_count() == 1

    def test_nth_book_adds_copies(self):
        session = _session()
        for title, vid in (
            ("Book One", "v1"),
            ("Book Two", "v2"),
            ("Spanish Word Search", "v3"),
        ):
            add_product_candidate(session, title=title, variant_id=vid, quantity=1)
            confirm_last_candidate(session)
        session.commerce_flow_status = STATUS_AWAITING_ANOTHER_BOOK
        hint = process_commerce_turn(
            session,
            "So I need the third book, the 10 copy of third book.",
        )
        assert hint.book_added
        ledger = get_ledger(session)
        assert ledger.confirmed_count() == 4
        titles = [i.title for i in ledger.confirmed_items]
        assert titles.count("Spanish Word Search") == 2


class TestSupportGoodbyeClearsEscalation:
    def test_goodbye_ends_support_handoff(self):
        session = _session(awaiting_not_found_escalation_email=True)
        session.pending_not_found_escalation = {"issue_title": "stuck"}
        closure = process_call_closure_turn(session, "No. No. Thank you. Bye bye.")
        assert closure is not None
        assert closure.end_call
        assert not session.awaiting_not_found_escalation_email
