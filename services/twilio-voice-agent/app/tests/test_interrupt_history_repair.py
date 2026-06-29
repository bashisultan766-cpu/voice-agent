"""Interrupt-safe OpenAI history repair for voice commerce brain."""
from __future__ import annotations

from app.agents.openai_request_utils import (
    repair_incomplete_tool_turns,
    rollback_interrupted_turn,
)


def test_repair_drops_orphan_assistant_tool_calls():
    history = [
        {"role": "user", "content": "order status"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": "call_1", "type": "function", "function": {"name": "lookup_shopify_order_details", "arguments": "{}"}},
            ],
        },
        {"role": "user", "content": "what is the status"},
    ]
    repaired = repair_incomplete_tool_turns(history)
    roles = [m["role"] for m in repaired]
    assert roles == ["user", "user"]


def test_repair_keeps_complete_tool_pairs():
    history = [
        {
            "role": "assistant",
            "tool_calls": [
                {"id": "call_1", "type": "function", "function": {"name": "lookup_shopify_order_details", "arguments": "{}"}},
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": '{"found": true}'},
        {"role": "assistant", "content": "Your order shipped."},
    ]
    repaired = repair_incomplete_tool_turns(history)
    assert len(repaired) == 3


def test_rollback_interrupted_turn_removes_user_prompt():
    history = [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "Hi there."},
        {"role": "user", "content": "order 21920"},
        {
            "role": "assistant",
            "tool_calls": [
                {"id": "call_2", "type": "function", "function": {"name": "lookup_shopify_order_details", "arguments": "{}"}},
            ],
        },
    ]
    rolled = rollback_interrupted_turn(history)
    assert rolled[-1]["content"] == "Hi there."
