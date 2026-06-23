"""v4.14.8 — Order/refund/facility route debug tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("VOICE_AGENT_RUNTIME_MODE", "main_llm_agent")

from app.agent_runtime.customer_service_orchestrator import route_customer_service_intent
from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents
from app.config import get_settings


class TestOrderRouteDebug:
    def test_order_maps_to_order_lookup_worker(self):
        route = route_customer_service_intent("Order number is 1234")
        plans = map_tool_categories_to_worker_intents(
            {"tool_categories": route["tool_categories"], "intent": route["intent"]},
            route.get("tool_entities") or {},
        )
        assert route["intent"] == "order_lookup"
        assert "order_lookup" in plans[0].worker_names

    def test_refund_maps_before_generic(self):
        route = route_customer_service_intent("Refund status for order 1234")
        assert route["intent"] == "refund_lookup"
        plans = map_tool_categories_to_worker_intents(
            {"tool_categories": route["tool_categories"], "intent": route["intent"]},
            route.get("tool_entities") or {},
        )
        assert "refund" in plans[0].worker_names[0] or "refund" in str(plans[0].worker_names)

    def test_facility_newspaper_restriction(self):
        route = route_customer_service_intent("Does this facility allow newspapers?")
        assert route["intent"] == "facility_approval"
        cats = route.get("tool_categories") or []
        assert "facility_approval" in cats or "facility_restriction" in cats

    def test_no_openai_live_tools(self):
        assert get_settings().VOICE_LIVE_DISABLE_OPENAI_TOOLS is True

    def test_no_legacy_runtime(self):
        assert get_settings().VOICE_AGENT_RUNTIME_MODE != "legacy_v410"
