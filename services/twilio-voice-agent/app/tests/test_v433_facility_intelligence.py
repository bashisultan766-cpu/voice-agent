"""v4.33 — facility document intelligence, order reconciliation, alternatives."""
from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.facility.book_content_matcher import check_book_against_facility
from app.facility.guidelines_registry import load_guidelines, lookup_facility_guideline
from app.facility.knowledge_context import build_facility_knowledge_block
from app.facility.order_reconciliation import reconcile_order_facility
from app.state.models import SessionState


def _session() -> SessionState:
    return SessionState(
        session_id="v433",
        call_sid="CA_V433",
        from_number="+15551234000",
        to_number="+15559999999",
        verified_phone=True,
    )


class TestGuidelinesRegistry:
    def test_loads_example_facility(self):
        load_guidelines(reload=True)
        fac = lookup_facility_guideline("Example Correctional Facility")
        assert fac is not None
        assert fac.website_url.startswith("https://")
        assert "hardcover" in fac.disallowed_formats

    def test_knowledge_block_includes_url(self):
        block = build_facility_knowledge_block(
            _session(),
            caller_text="Example Correctional Facility",
        )
        assert "example.com" in block.lower()


class TestBookContentMatcher:
    def test_hardcover_rejected(self):
        fac = lookup_facility_guideline("Example Correctional Facility")
        result = check_book_against_facility(
            title="The Art of War Hardcover Edition",
            facility=fac,
        )
        assert not result.allowed
        assert any("hardcover" in r.lower() for r in result.reasons)

    def test_paperback_allowed(self):
        fac = lookup_facility_guideline("Example Correctional Facility")
        result = check_book_against_facility(
            title="Daily Devotional Paperback",
            facility=fac,
        )
        assert result.allowed

    def test_violence_keyword_rejected(self):
        fac = lookup_facility_guideline("Example Correctional Facility")
        result = check_book_against_facility(
            title="Street Violence and Gangs",
            facility=fac,
        )
        assert not result.allowed


class TestOrderReconciliation:
    @pytest.mark.asyncio
    async def test_reconcile_mixed_order(self):
        session = _session()
        order_payload = json.dumps({
            "found": True,
            "order_number": "#9001",
            "status": "PAID",
            "fulfillment_status": "PARTIALLY_FULFILLED",
            "items": [
                "1x Daily Devotional Paperback",
                "1x War Hardcover Complete",
            ],
        })
        search_side_effect = [
            json.dumps({"results": [{"title": "Daily Devotional Paperback", "tags": ["paperback"]}]}),
            json.dumps({"results": [{"title": "War Hardcover Complete", "tags": ["hardcover"]}]}),
            json.dumps({"results": [{"title": "Peace Paperback", "isbn": "9780000000001"}]}),
        ]

        with patch(
            "app.tools.shopify_tools.lookup_order",
            new_callable=AsyncMock,
            return_value=order_payload,
        ), patch(
            "app.tools.shopify_tools.search_products",
            new_callable=AsyncMock,
            side_effect=search_side_effect,
        ):
            recon = await reconcile_order_facility(
                session,
                "9001",
                "Example Correctional Facility",
                phone="+15551234000",
            )

        assert len(recon.accepted) >= 1
        assert len(recon.rejected) >= 1
        assert "example.com" in recon.customer_message.lower()
        assert recon.website_url
