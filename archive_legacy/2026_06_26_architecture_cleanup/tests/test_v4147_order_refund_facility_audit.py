"""v4.14.7 — Order/refund/facility audit tests."""
from __future__ import annotations

import os
import subprocess
import sys

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.business_intent_resolver import resolve_business_intent
from app.agent_runtime.customer_service_orchestrator import route_customer_service_intent
from app.agent_runtime.tool_audit_runner import run_all_audits


class TestOrderRefundFacilityAudit:
    def test_order_number_routes_order_lookup(self):
        route = route_customer_service_intent("Order number is 1234")
        assert route["intent"] == "order_lookup"
        assert route["response_mode"] == "needs_tools"

    def test_refund_routes_before_generic_order(self):
        route = route_customer_service_intent("Refund status for order 1234")
        assert route["intent"] == "refund_lookup"
        assert route["response_mode"] == "needs_tools"

    def test_facility_magazine_newspaper(self):
        for phrase in (
            "Is Red Rock facility approved?",
            "Does this facility allow magazines?",
            "Does this facility allow newspapers?",
        ):
            route = route_customer_service_intent(phrase)
            assert route["intent"] == "facility_approval", phrase

    def test_audit_runner_all_ok(self):
        results = run_all_audits()
        assert all(r.ok for r in results), [f"{r.name}: {r.detail}" for r in results if not r.ok]

    def test_audit_script_runs(self):
        from app.agent_runtime.tool_audit_runner import format_audit_report, run_all_audits

        report = format_audit_report(run_all_audits())
        assert "Newspaper search: OK" in report
        assert "FAIL" not in report

    def test_order_via_business_intent(self):
        biz = resolve_business_intent("Check order status for 1234")
        assert biz.intent == "order_lookup"
