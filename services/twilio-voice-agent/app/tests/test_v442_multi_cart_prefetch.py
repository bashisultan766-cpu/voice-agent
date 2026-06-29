"""v4.42 — multi-book cart, multi-email qty split, parallel turn prefetch."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from app.agent_runtime.commerce_flow_state import (
    COMMERCE_FLOW_VERSION,
    STATUS_AWAITING_ANOTHER_BOOK,
    advance_commerce_state_silent,
    on_book_added_to_cart,
)
from app.agent_runtime.turn_prefetch import (
    TURN_PREFETCH_VERSION,
    run_turn_prefetch,
)
from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
from app.payment.payment_destination_groups import (
    group_checkout_items,
    try_parse_quantity_email_split,
)
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="v442",
        call_sid="CA4d6b46a62b63d212e99f751242746139",
        from_number="+19235551234",
        to_number="+2",
    )
    base.update(kwargs)
    return SessionState(**base)


class TestVersions:
    def test_versions(self):
        assert COMMERCE_FLOW_VERSION == "v4.51"
        assert TURN_PREFETCH_VERSION == "v4.43"


class TestMultiEmailQuantitySplit:
    def test_split_one_title_two_emails(self):
        session = _session()
        add_product_candidate(
            session,
            title="A Feast for Crows",
            isbn="9780553582024",
            variant_id="v-feast",
            price="10.99",
            quantity=5,
        )
        confirm_last_candidate(session)

        groups = try_parse_quantity_email_split(
            "send 2 copies to bashi at gmail dot com and 3 copies to orders at company dot com",
            session,
        )
        assert groups is not None
        assert len(groups) == 2
        assert groups[0]["pending_email"]
        assert groups[1]["pending_email"]
        session.payment_destination_groups = groups
        session.active_payment_group_index = 0
        lines = group_checkout_items(session, groups[0])
        assert sum(l["quantity"] for l in lines) == 2


class TestCommerceAnotherBook:
    def test_done_shopping_moves_to_email(self):
        session = _session()
        add_product_candidate(
            session,
            title="Book A",
            variant_id="v1",
            quantity=1,
        )
        confirm_last_candidate(session)
        on_book_added_to_cart(session, "Book A")
        assert session.commerce_flow_status == STATUS_AWAITING_ANOTHER_BOOK

        advance_commerce_state_silent(session, "No that's all, checkout please.")
        assert session.payment_flow_status == "awaiting_email"


class TestTurnPrefetch:
    @pytest.mark.asyncio
    async def test_order_prefetch_populates_cache(self):
        session = _session(last_order_number="47905")
        fake_order = {
            "found": True,
            "order_number": "47905",
            "status": "PAID",
            "fulfillment_status": "UNFULFILLED",
            "items": ["1x A Feast for Crows"],
            "suggested_response": "Order 47905 is PAID.",
        }

        with patch(
            "app.agent_runtime.order_parallel_enrichment.enrich_order_parallel",
            new_callable=AsyncMock,
        ) as mock_enrich:
            from app.agent_runtime.order_parallel_enrichment import OrderEnrichmentResult

            mock_enrich.return_value = OrderEnrichmentResult(
                order_number="47905",
                order=fake_order,
                suggested_response=fake_order["suggested_response"],
                verified=True,
            )
            await run_turn_prefetch(
                session,
                "What's the title of the book in order 47905?",
                max_wait_ms=500,
            )

        assert "order" in session.turn_prefetch_cache
        assert session.order_context
