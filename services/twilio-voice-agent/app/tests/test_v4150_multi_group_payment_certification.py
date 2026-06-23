"""v4.15.0 — Multi-group payment certification tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.commerce_session import (
    ProductCandidate,
    add_selected_candidate_to_cart,
    clear_commerce_session,
    get_commerce_session,
    update_candidates_from_facts,
)
from app.agent_runtime.payment_link_orchestrator import (
    assign_group_idempotency,
    assign_lines_to_group,
    certify_group_payment,
    format_partial_multi_group_message,
    group_cart_items,
)
from app.payment.payment_idempotency import clear_idempotency_store, compute_idempotency_key


def _setup_cart(n=3):
    clear_commerce_session("CA4150MG")
    clear_idempotency_store()
    commerce = get_commerce_session("CA4150MG")
    for i in range(n):
        update_candidates_from_facts(commerce, [
            ProductCandidate(
                candidate_id=f"c{i}", product_id=f"p{i}", variant_id=f"v{i}",
                title=f"Item {i+1}", author=None, isbn=None, price="$10",
                currency="USD", availability="available", inventory_quantity=1,
                source="search", confidence=0.9,
            ),
        ])
        commerce.selected_candidate_id = f"c{i}"
        add_selected_candidate_to_cart(commerce)
    return commerce


class TestMultiGroupPaymentCertification:
    @pytest.mark.asyncio
    async def test_two_groups_two_idempotency_keys(self):
        commerce = _setup_cart(3)
        g1 = assign_lines_to_group(commerce, [commerce.active_cart[0].line_id], email="a@test.com")
        g2 = assign_lines_to_group(commerce, [commerce.active_cart[1].line_id], email="b@test.com")
        group1 = next(g for g in commerce.destination_groups if g.group_id == g1["group_id"])
        group2 = next(g for g in commerce.destination_groups if g.group_id == g2["group_id"])
        group1.confirmed_email = True
        group2.confirmed_email = True
        k1 = assign_group_idempotency(commerce, group1, confirmed_email="a@test.com")
        k2 = assign_group_idempotency(commerce, group2, confirmed_email="b@test.com")
        assert k1 != k2

    @pytest.mark.asyncio
    async def test_certify_group_dry_run_success(self):
        commerce = _setup_cart(1)
        g = assign_lines_to_group(commerce, [commerce.active_cart[0].line_id], email="test@example.com")
        group = next(gr for gr in commerce.destination_groups if gr.group_id == g["group_id"])
        group.confirmed_email = True
        from app.state.models import SessionState
        ss = SessionState(session_id="s", call_sid="CA4150MG", from_number="", to_number="")
        ss.confirmed_email = "test@example.com"
        result = await certify_group_payment(commerce, group, ss)
        assert result["success"]
        assert result["checkout_ok"]
        assert result["email_ok"]

    def test_partial_success_message(self):
        from app.agent_runtime.commerce_session import DestinationGroup

        g1 = DestinationGroup(
            group_id="g1", name="A", email="a@gmail.com", address=None,
            facility_name=None, inmate_name=None, confirmed_email=True, confirmed_destination=True,
        )
        g2 = DestinationGroup(
            group_id="g2", name="B", email="b@company.com", address=None,
            facility_name=None, inmate_name=None, confirmed_email=True, confirmed_destination=True,
        )
        msg = format_partial_multi_group_message([g1, g2], succeeded_ids=["g1"], failed_ids=["g2"])
        assert "first payment link" in msg.lower()
        assert "@" not in msg or "***" in msg

    def test_group_cart_items_isolated(self):
        commerce = _setup_cart(2)
        g1 = assign_lines_to_group(commerce, [commerce.active_cart[0].line_id])
        group = next(gr for gr in commerce.destination_groups if gr.group_id == g1["group_id"])
        items = group_cart_items(commerce, group)
        assert len(items) == 1
        assert items[0]["variant_id"] == "v0"
