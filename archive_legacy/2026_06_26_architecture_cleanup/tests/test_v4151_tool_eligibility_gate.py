"""v4.15.1 — Tool eligibility gate tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")


class TestToolEligibilityGate:
    def test_blocks_how_are_you_tools(self):
        from app.agent_runtime.tool_eligibility_gate import evaluate_tool_eligibility

        r = evaluate_tool_eligibility(
            "How are you?",
            {
                "response_mode": "needs_tools",
                "intent": "unknown",
                "tool_categories": ["catalog_search"],
            },
        )
        assert r.blocked
        assert not r.allowed

    def test_allows_usa_today_subscription(self):
        from app.agent_runtime.tool_eligibility_gate import evaluate_tool_eligibility

        r = evaluate_tool_eligibility(
            "I need USA Today 5 day delivery for 3 months.",
            {
                "response_mode": "needs_tools",
                "intent": "newspaper_search",
                "tool_categories": ["catalog_search"],
            },
        )
        assert r.allowed
        assert not r.blocked

    def test_allows_order_number(self):
        from app.agent_runtime.tool_eligibility_gate import evaluate_tool_eligibility

        r = evaluate_tool_eligibility(
            "Order number is 1234",
            {
                "response_mode": "needs_tools",
                "intent": "order_lookup",
                "tool_categories": ["order_lookup"],
            },
        )
        assert r.allowed

    def test_blocks_payment_without_cart(self):
        from app.agent_runtime.commerce_session import get_commerce_session
        from app.agent_runtime.tool_eligibility_gate import evaluate_tool_eligibility

        commerce = get_commerce_session("CAelig1")
        r = evaluate_tool_eligibility(
            "Send payment link.",
            {
                "response_mode": "needs_tools",
                "intent": "payment",
                "tool_categories": ["payment_flow"],
            },
            commerce,
        )
        assert r.blocked
        assert "payment" in r.direct_answer.lower() or "item" in r.direct_answer.lower()

    def test_conversation_only_detection(self):
        from app.agent_runtime.tool_eligibility_gate import is_conversation_only_turn

        assert is_conversation_only_turn("Do you remember me?")
        assert is_conversation_only_turn("Who are you?")
        assert not is_conversation_only_turn("Order number is 1234")
