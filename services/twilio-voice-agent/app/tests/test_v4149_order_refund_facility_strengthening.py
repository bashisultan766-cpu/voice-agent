"""v4.14.9 — Order/refund/facility strengthening tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("VOICE_AGENT_RUNTIME_MODE", "main_llm_agent")

from app.agent_runtime.customer_service_orchestrator import route_customer_service_intent
from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents
from app.config import get_settings


class TestOrderRefundFacilityStrengthening:
    def test_order_number_routes_order_lookup(self):
        route = route_customer_service_intent("Order number is 1234.")
        plans = map_tool_categories_to_worker_intents(
            {"tool_categories": route["tool_categories"], "intent": route["intent"]},
            route.get("tool_entities") or {},
        )
        assert route["intent"] == "order_lookup"
        assert "order_lookup" in plans[0].worker_names

    def test_refund_routes_before_order(self):
        route = route_customer_service_intent("Refund status for order 1234.")
        assert route["intent"] == "refund_lookup"
        plans = map_tool_categories_to_worker_intents(
            {"tool_categories": route["tool_categories"], "intent": route["intent"]},
            route.get("tool_entities") or {},
        )
        worker_str = str(plans[0].worker_names)
        assert "refund" in worker_str

    def test_facility_newspaper_restriction(self):
        route = route_customer_service_intent("Does this facility allow newspapers?")
        assert route["intent"] == "facility_approval"
        cats = route.get("tool_categories") or []
        assert "facility_approval" in cats or "facility_restriction" in cats

    def test_facility_magazine_restriction(self):
        route = route_customer_service_intent("Does this facility allow magazines?")
        assert route["intent"] == "facility_approval"

    def test_address_update_escalation(self):
        route = route_customer_service_intent("I need to update my shipping address.")
        assert route["intent"] == "address_update"
        cats = route.get("tool_categories") or []
        assert "address_update" in cats or "escalation" in cats

    def test_no_openai_live_tools(self):
        assert get_settings().VOICE_LIVE_DISABLE_OPENAI_TOOLS is True

    def test_no_legacy_v410(self):
        assert get_settings().VOICE_AGENT_RUNTIME_MODE != "legacy_v410"

    def test_refund_wins_over_order_for_same_utterance(self):
        refund = route_customer_service_intent("Refund status for order 1234.")
        order = route_customer_service_intent("Order number is 1234.")
        assert refund["intent"] == "refund_lookup"
        assert order["intent"] == "order_lookup"
