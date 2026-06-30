"""LLM input sandbox — workflow state must not reach the model."""
from __future__ import annotations

import json

from app.agent_runtime.llm_sandbox import (
    build_conversation_summary_for_llm,
    sanitize_llm_input,
    sanitize_support_llm_user_content,
    sanitize_text_block,
    sanitize_tool_output_content,
    sanitize_user_text,
)
from app.agents.main_commerce_brain import MainCommerceBrain, _ERIC_SYSTEM_PROMPT
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="s",
        call_sid="CA_SANDBOX",
        from_number="+1",
        to_number="+2",
        **kwargs,
    )


def test_sanitize_user_text_strips_workflow_names():
    raw = "Find product_search_workflow item gid://shopify/ProductVariant/1"
    assert "product_search_workflow" not in sanitize_user_text(raw)
    assert "gid://shopify" not in sanitize_user_text(raw)


def test_sanitize_text_block_removes_live_call_state():
    raw = (
        "LIVE CALL STATE (context only — do not read aloud):\n"
        "- Payment flow: awaiting_email\n"
        "- Resolved ISBN from caller speech: 9780747532699. Call search_product_by_isbn immediately\n"
        "Real conversation here."
    )
    out = sanitize_text_block(raw)
    assert "LIVE CALL STATE" not in out
    assert "Payment flow" not in out
    assert "search_product_by_isbn" not in out
    assert "Real conversation here" in out


def test_sanitize_tool_output_strips_structured_catalog_json():
    payload = json.dumps({
        "results": [{"title": "Atomic Habits", "variant_id": "gid://shopify/ProductVariant/1"}],
        "count": 1,
    })
    out = sanitize_tool_output_content("catalog_search", payload)
    assert "variant_id" not in out
    assert "gid://shopify" not in out
    assert "Atomic Habits" not in out


def test_sanitize_tool_output_keeps_customer_message():
    payload = json.dumps({"customer_message": "I found your order for two books."})
    assert "two books" in sanitize_tool_output_content("lookup_shopify_order_details", payload)


def test_sanitize_llm_input_drops_tool_history():
    messages = [
        {"role": "system", "content": f"{_ERIC_SYSTEM_PROMPT}\n\nConversation so far:\nHi"},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "1"}]},
        {"role": "tool", "tool_call_id": "1", "content": '{"variant_id":"x"}'},
        {"role": "user", "content": "thanks"},
    ]
    clean = sanitize_llm_input(messages)
    roles = [m["role"] for m in clean]
    assert "tool" in roles
    assert "variant_id" not in json.dumps(clean)


def test_build_messages_excludes_workflow_state():
    brain = MainCommerceBrain(settings=type("S", (), {"OPENAI_API_KEY": "k"})())
    session = _session(
        payment_flow_status="awaiting_email",
        commerce_flow_status="awaiting_quantity",
        last_order_number="12345",
    )
    session.history = [
        {"role": "tool", "tool_call_id": "t1", "content": '{"variant_id":"gid://shopify/x"}'},
        {"role": "user", "content": "I need Atomic Habits"},
    ]
    messages = brain.build_messages(session, "Do you have it?")
    blob = json.dumps(messages)
    assert "Payment flow:" not in blob
    assert "awaiting_quantity" not in blob
    assert "awaiting_email" not in blob
    assert "variant_id" not in blob
    assert "gid://shopify" not in blob


def test_sanitize_support_llm_user_content_omits_api_context():
    out = sanitize_support_llm_user_content(
        issue_title="Missing book",
        issue_detail="Not in catalog",
        customer_name="Maria",
        transcript="user: I need Gurdwara",
    )
    assert "api_context" not in out.lower()
    assert "workflow" not in out.lower()
    assert "Gurdwara" in out
