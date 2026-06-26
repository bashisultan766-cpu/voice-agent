"""v4.14.9 — Multi-payment link tests."""
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
    GROUP_STATES,
    advance_group_state,
    assign_lines_to_group,
    create_multi_payment_groups,
    handle_multi_group_payment,
    handle_payment_request,
    mark_group_checkout_result,
    mark_group_email_sent,
    parse_multi_group_assignment,
    payment_blocked_message,
    payment_success_message,
)


def _session():
    from app.state.models import SessionState

    return SessionState(
        session_id="sess4149pay",
        call_sid="CA4149PAY",
        from_number="+15551234567",
        to_number="+15559876543",
    )


def _cart_with_lines(n: int = 6):
    clear_commerce_session("CA4149PAY")
    commerce = get_commerce_session("CA4149PAY")
    lines = []
    for i in range(n):
        update_candidates_from_facts(commerce, [
            ProductCandidate(
                candidate_id=f"c{i}", product_id=f"p{i}", variant_id=f"v{i}",
                title=f"Book {i+1}", author=None, isbn=None, price="$10",
                currency="USD", availability="available", inventory_quantity=1,
                source="search", confidence=0.9,
            ),
        ])
        commerce.selected_candidate_id = f"c{i}"
        line = add_selected_candidate_to_cart(commerce)
        if line:
            lines.append(line)
    return commerce, lines


class TestMultiPaymentLinks:
    def test_group_states_defined(self):
        assert "group_created" in GROUP_STATES
        assert "payment_link_sent" in GROUP_STATES
        assert "checkout_create_pending" in GROUP_STATES

    def test_single_payment_flow_mocked(self):
        commerce, lines = _cart_with_lines(1)
        ss = _session()
        ss.cart_items = [{"title": "Book 1", "variant_id": "v0", "quantity": 1, "confirmation_status": "candidate"}]
        r1 = handle_payment_request(commerce, session_state=ss)
        assert r1["expected_next"] in ("cart_confirm", "email_capture")
        ss.confirmed_email = "test@example.com"
        r2 = handle_payment_request(commerce, session_state=ss, cart_confirmed=True, email_confirmed=True)
        assert r2["expected_next"] == "checkout_create"
        assert r2["response_mode"] == "needs_tools"

    def test_two_payment_groups_two_emails(self):
        commerce, lines = _cart_with_lines(6)
        text = (
            "Send these 2 books to bashi at gmail dot com "
            "and the other 4 books to orders at company dot com."
        )
        assignments = parse_multi_group_assignment(text, commerce)
        assert assignments is not None
        assert len(assignments) == 2
        groups = create_multi_payment_groups(commerce, assignments)
        assert len(groups) == 2
        assert groups[0].email != groups[1].email
        assert len(groups[0].cart_line_ids) == 2
        assert len(groups[1].cart_line_ids) == 4

    def test_no_cross_mixing_lines(self):
        commerce, lines = _cart_with_lines(4)
        g1 = assign_lines_to_group(commerce, [lines[0].line_id, lines[1].line_id], email="a@test.com")
        g2 = assign_lines_to_group(commerce, [lines[2].line_id, lines[3].line_id], email="b@test.com")
        assert g1["group_id"] != g2["group_id"]
        g1_lines = set(g1["titles"])
        g2_lines = set(g2["titles"])
        assert not g1_lines.intersection(g2_lines)

    def test_checkout_failure_blocks_sent(self):
        msg = payment_success_message("test@example.com", checkout_ok=False, email_ok=True)
        assert "sent" not in msg.lower() or "couldn't" in msg.lower()

    def test_email_failure_blocks_sent(self):
        msg = payment_success_message("test@example.com", checkout_ok=True, email_ok=False)
        assert "confirm the email" in msg.lower() or "couldn't" in msg.lower()

    def test_unconfirmed_email_blocks_checkout(self):
        commerce, lines = _cart_with_lines(2)
        g = assign_lines_to_group(commerce, [lines[0].line_id], email="pending@test.com")
        group = next(gr for gr in commerce.destination_groups if gr.group_id == g["group_id"])
        result = advance_group_state(group, commerce=commerce, cart_confirmed=True)
        assert result["state"] in ("email_spellback_required", "email_capture_required")

    def test_group_checkout_and_email_markers(self):
        commerce, lines = _cart_with_lines(1)
        g = assign_lines_to_group(commerce, [lines[0].line_id], email="ok@test.com")
        group = next(gr for gr in commerce.destination_groups if gr.group_id == g["group_id"])
        group.confirmed_cart = True
        group.confirmed_email = True
        mark_group_checkout_result(group, success=True, checkout_id="chk123")
        assert group.checkout_status == "created"
        mark_group_email_sent(group, success=True, email="ok@test.com")
        assert group.payment_link_status == "sent"

    def test_partial_group_failure_message(self):
        commerce, lines = _cart_with_lines(4)
        assign_lines_to_group(commerce, [lines[0].line_id], email="a@test.com")
        assign_lines_to_group(commerce, [lines[1].line_id], email="b@test.com")
        msg = payment_blocked_message(checkout_ok=True, email_ok=False)
        assert "confirm the email" in msg.lower()
