"""v4.14.6 — Payment recovery tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.commerce_session import (
    ProductCandidate,
    add_selected_candidate_to_cart,
    clear_commerce_session,
    get_commerce_session,
    update_candidates_from_facts,
)
from app.agent_runtime.payment_link_orchestrator import (
    handle_payment_request,
    parse_spoken_email,
    payment_success_message,
    prepare_email_spellback,
)


def _session_state():
    from app.state.models import SessionState

    return SessionState(
        session_id="sess4146pay",
        call_sid="CA4146PAY",
        from_number="+15551234567",
        to_number="+15559876543",
    )


class TestPaymentRecovery:
    def test_empty_cart_with_candidates_asks_add(self):
        clear_commerce_session("CA4146PAY")
        commerce = get_commerce_session("CA4146PAY")
        update_candidates_from_facts(commerce, [
            ProductCandidate(
                candidate_id="b1",
                product_id="p1",
                variant_id="v1",
                title="When Scars Become Stories",
                author=None,
                isbn="9798893960648",
                price="$16.99",
                currency="USD",
                availability="available",
                inventory_quantity=5,
                source="isbn",
                confidence=0.99,
            )
        ])
        result = handle_payment_request(commerce, session_state=_session_state())
        assert "haven't added" in result["message"].lower() or "have not added" in result["message"].lower()
        assert result["expected_next"] == "confirm_add_candidates"
        assert "empty" not in result["message"].lower() or "haven't" in result["message"].lower()

    def test_cart_with_lines_asks_confirmation(self):
        clear_commerce_session("CA4146PAY")
        commerce = get_commerce_session("CA4146PAY")
        update_candidates_from_facts(commerce, [
            ProductCandidate(
                candidate_id="b1",
                product_id="p1",
                variant_id="v1",
                title="Dune",
                author=None,
                isbn=None,
                price="$10",
                currency="USD",
                availability="available",
                inventory_quantity=1,
                source="search",
                confidence=0.9,
            )
        ])
        add_selected_candidate_to_cart(commerce)
        session = _session_state()
        session.cart_items = [{
            "title": "Dune",
            "variant_id": "v1",
            "quantity": 1,
            "confirmation_status": "candidate",
        }]
        result = handle_payment_request(commerce, session_state=session)
        assert "Should I send the payment link" in result["message"]

    def test_email_capture_after_cart_confirm(self):
        clear_commerce_session("CA4146PAY")
        commerce = get_commerce_session("CA4146PAY")
        update_candidates_from_facts(commerce, [
            ProductCandidate(
                candidate_id="b1",
                product_id="p1",
                variant_id="v1",
                title="Dune",
                author=None,
                isbn=None,
                price="$10",
                currency="USD",
                availability="available",
                inventory_quantity=1,
                source="search",
                confidence=0.9,
            )
        ])
        add_selected_candidate_to_cart(commerce)
        session = _session_state()
        session.cart_items = [{
            "title": "Dune",
            "variant_id": "v1",
            "quantity": 1,
            "confirmation_status": "confirmed",
        }]
        result = handle_payment_request(commerce, session_state=session, cart_confirmed=True)
        assert "email" in result["message"].lower()

    def test_email_spellback(self):
        email = parse_spoken_email("bashi sultan 766 at gmail dot com")
        assert email and "766" in email
        msg = prepare_email_spellback(email)
        assert "Is that correct" in msg

    def test_success_message_masks_email(self):
        msg = payment_success_message("bashi.sultan766@gmail.com", checkout_id="chk1")
        assert "sent the payment link" in msg.lower()
        assert "bashi.sultan766@gmail.com" not in msg
