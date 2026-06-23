"""v4.14.5 — Payment link orchestrator tests."""
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
    payment_success_message,
    prepare_email_spellback,
)


def _session():
    from app.state.models import SessionState

    return SessionState(
        session_id="sess4145pay",
        call_sid="CA4145PAY",
        from_number="+15551234567",
        to_number="+15559876543",
    )


class TestPaymentLinkOrchestrator:
    def test_empty_cart_blocked(self):
        clear_commerce_session("CA4145PAY")
        commerce = get_commerce_session("CA4145PAY")
        result = handle_payment_request(commerce, session_state=_session())
        assert result["response_mode"] == "direct_answer"
        assert "empty" in result["message"].lower()

    def test_cart_confirm_required(self):
        clear_commerce_session("CA4145PAY")
        commerce = get_commerce_session("CA4145PAY")
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
        session = _session()
        session.cart_items = [{
            "title": "Dune",
            "variant_id": "v1",
            "quantity": 1,
            "confirmation_status": "candidate",
        }]
        result = handle_payment_request(commerce, session_state=session)
        assert "Should I send the payment link" in result["message"]

    def test_email_capture_required(self):
        clear_commerce_session("CA4145PAY")
        commerce = get_commerce_session("CA4145PAY")
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
        session = _session()
        session.cart_items = [{
            "title": "Dune",
            "variant_id": "v1",
            "quantity": 1,
            "confirmation_status": "confirmed",
        }]
        result = handle_payment_request(commerce, session_state=session, cart_confirmed=True)
        assert "email" in result["message"].lower()

    def test_email_spellback_clean(self):
        msg = prepare_email_spellback("bashi.sultan766@gmail.com")
        assert "b, a, s, h, i" not in msg
        assert "Is that correct" in msg

    def test_success_message_requires_resend(self):
        msg = payment_success_message("alice@example.com", checkout_id="chk123")
        assert "sent the payment link" in msg.lower()
        assert "alice@example.com" not in msg

    def test_missing_variant_blocked(self):
        clear_commerce_session("CA4145PAY")
        commerce = get_commerce_session("CA4145PAY")
        commerce.active_cart.append(type("L", (), {
            "line_id": "1", "product_id": "p", "variant_id": "",
            "title": "X", "isbn": None, "price": None, "quantity": 1,
            "destination_group_id": None, "status": "active",
        })())
        result = handle_payment_request(commerce, session_state=_session(), cart_confirmed=True)
        assert "confirmed book listings" in result["message"]
