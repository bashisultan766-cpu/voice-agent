"""v4.14.5 — Order/refund/facility orchestrator tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.business_intent_resolver import resolve_business_intent
from app.agent_runtime.customer_service_orchestrator import route_customer_service_intent


class TestOrderRefundFacilityOrchestrator:
    def test_order_number_routes_lookup(self):
        route = route_customer_service_intent("Order number is 1234")
        assert route["intent"] == "order_lookup"
        assert route["response_mode"] == "needs_tools"

    def test_order_status_without_id_asks(self):
        route = route_customer_service_intent("Check order status")
        assert route["intent"] == "order_lookup"
        assert route["response_mode"] == "direct_answer"
        assert "order number" in route["direct_answer"].lower()

    def test_refund_before_order(self):
        route = route_customer_service_intent("Refund status for order 1234")
        assert route["intent"] == "refund_lookup"
        assert route["tool_entities"]["order_number"] == "1234"

    def test_facility_fanout(self):
        route = route_customer_service_intent("Is this facility approved for books?")
        assert route["intent"] == "facility_approval"
        assert "facility_approval" in route["tool_categories"]
        assert "facility_restriction" in route["tool_categories"]

    @pytest.mark.asyncio
    async def test_address_update_escalation(self):
        result = resolve_business_intent("Update my shipping address")
        assert result.matched
        assert result.intent == "address_update"
        assert "escalation" in result.tool_categories
