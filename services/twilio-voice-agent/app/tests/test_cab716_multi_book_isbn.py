"""Regression CAb716 — ISBN + multi-book cart must not hijack to cart inquiry or support."""
from __future__ import annotations

from app.agent_runtime.commerce_flow_state import (
    COMMERCE_FLOW_VERSION,
    STATUS_AWAITING_ADD_CONFIRM,
    STATUS_AWAITING_ANOTHER_BOOK,
    STATUS_AWAITING_QUANTITY,
    add_staged_book_to_cart,
    process_commerce_turn,
    stage_product_candidate,
    try_cart_inquiry_reply,
)
from app.agent_runtime.isbn_short_circuit import (
    _ASSEMBLER_KEEPALIVE,
    looks_like_book_title_request,
    try_title_catalog_short_circuit,
)
from app.agent_runtime.not_found_escalation_flow import (
    clear_pending_escalation,
    should_clear_handoff_for_shopping,
    stage_pending_escalation,
)
from app.agent_runtime.workflow_isolation import (
    WORKFLOW_COMMERCE,
    WORKFLOW_PRODUCT,
    product_handling_allowed,
    resolve_primary_workflow,
)
from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="cab716",
        call_sid="CAb7162ff25c17fe4e8e0117c97e6b24bd",
        from_number="+1",
        to_number="+2",
    )
    base.update(kwargs)
    return SessionState(**base)


def _cart_with_got(session: SessionState) -> None:
    add_product_candidate(
        session,
        title="A Game of Thrones",
        isbn="9780553573404",
        variant_id="v-got",
        quantity=2,
    )
    confirm_last_candidate(session)
    session.commerce_flow_status = STATUS_AWAITING_ANOTHER_BOOK


class TestVersions:
    def test_commerce_flow_version(self):
        assert COMMERCE_FLOW_VERSION == "v4.54"


class TestIsbnDuringActiveCart:
    def test_isbn_preempts_commerce_workflow(self):
        session = _session()
        _cart_with_got(session)
        assert resolve_primary_workflow(
            session, "isbn", "9780553579901",
        ) == WORKFLOW_PRODUCT
        assert product_handling_allowed(session, "isbn", "9780553579901")

    def test_cart_inquiry_skips_isbn_and_purchase_intent(self):
        session = _session()
        _cart_with_got(session)
        assert try_cart_inquiry_reply(
            session,
            "Okay. The third book ISBN number is 9780553579901.",
            turn_mode="isbn",
        ) is None
        assert try_cart_inquiry_reply(
            session,
            "I want to buy the third book.",
        ) is None
        assert try_cart_inquiry_reply(
            session,
            "What is in my cart?",
        ) is not None

    def test_another_book_isbn_clears_wrong_handoff(self):
        session = _session()
        _cart_with_got(session)
        stage_pending_escalation(session, {"issue_title": "false alarm"})
        assert session.awaiting_not_found_escalation_email
        assert should_clear_handoff_for_shopping(
            session, "9780553392968", turn_mode="isbn",
        )
        clear_pending_escalation(session)
        assert not session.awaiting_not_found_escalation_email
        assert resolve_primary_workflow(
            session, "isbn", "9780553392968",
        ) == WORKFLOW_PRODUCT


class TestQuantityDuringStagedBook:
    def test_ten_copies_of_this_book_adds_directly(self):
        session = _session()
        stage_product_candidate(session, {
            "title": "A Clash of Kings",
            "isbn": "9780553579901",
            "variant_id": "v-acok",
            "price": "9.99",
            "available": True,
        })
        session.commerce_flow_status = STATUS_AWAITING_ADD_CONFIRM
        session.commerce_pending_quantity = 1
        hint = process_commerce_turn(session, "10 copy of this book.")
        assert hint.book_added
        assert get_ledger(session).confirmed_count() == 1
        item = get_ledger(session).confirmed_items[0]
        assert item.quantity == 10

    def test_repeated_no_starts_payment_email(self):
        session = _session()
        _cart_with_got(session)
        hint = process_commerce_turn(session, "No. No. No. No. No. No.")
        assert hint.force_reply
        assert "email" in hint.force_reply.lower()


class TestKeepaliveDoesNotTriggerTitleSearch:
    def test_keepalive_not_title_request(self):
        assert not looks_like_book_title_request(_ASSEMBLER_KEEPALIVE)

    async def test_title_catalog_skips_keepalive(self):
        session = _session()
        _cart_with_got(session)
        result = await try_title_catalog_short_circuit(
            session, _ASSEMBLER_KEEPALIVE,
        )
        assert result is None
