"""v4.14.5 — Multi-destination payment tests."""
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
from app.agent_runtime.payment_link_orchestrator import assign_lines_to_group, multi_group_summary


class TestMultiDestinationPayments:
    def test_two_destination_groups(self):
        clear_commerce_session("CA4145MD")
        commerce = get_commerce_session("CA4145MD")
        update_candidates_from_facts(commerce, [
            ProductCandidate(
                candidate_id="b1", product_id="p1", variant_id="v1",
                title="Book One", author=None, isbn=None, price="$10",
                currency="USD", availability="available", inventory_quantity=1,
                source="search", confidence=0.9,
            ),
            ProductCandidate(
                candidate_id="b2", product_id="p2", variant_id="v2",
                title="Book Two", author=None, isbn=None, price="$12",
                currency="USD", availability="available", inventory_quantity=1,
                source="search", confidence=0.9,
            ),
        ])
        l1 = add_selected_candidate_to_cart(commerce)
        commerce.selected_candidate_id = "b2"
        l2 = add_selected_candidate_to_cart(commerce)
        g1 = assign_lines_to_group(commerce, [l1.line_id], name="Facility A", email="a@example.com")
        g2 = assign_lines_to_group(commerce, [l2.line_id], name="Facility B", email="b@example.com")
        assert g1["group_id"] != g2["group_id"]
        summary = multi_group_summary(commerce)
        assert summary is not None
        assert "separate payment links" in summary
