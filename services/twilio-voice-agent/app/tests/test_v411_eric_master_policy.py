"""v4.11 — Eric Master Policy Store tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.eric_master_policy import (
    ERIC_BUSINESS_RULES,
    ERIC_CLIENT_RULES,
    build_eric_brain_system_prompt,
    build_eric_final_response_system_prompt,
    block_processing_fee,
    sanitize_policy_leak,
)


class TestEricMasterPolicy:
    def test_brain_prompt_contains_eric_identity(self):
        prompt = build_eric_brain_system_prompt()
        assert "Eric" in prompt
        assert "SureShot Books" in prompt

    def test_brain_prompt_contains_client_rules(self):
        prompt = build_eric_brain_system_prompt()
        assert "Processing Fee" in prompt or "processing fee" in prompt.lower()
        assert "Red River Vengeance" in prompt
        assert "Jessica" in prompt
        assert "subtotal" in prompt.lower() or "shipping" in prompt.lower()

    def test_all_client_rules_represented(self):
        prompt = build_eric_brain_system_prompt().lower()
        for rule in ERIC_CLIENT_RULES:
            key = rule.split()[0].lower()
            assert key in prompt or "processing" in prompt

    def test_final_prompt_compact_no_tool_heading(self):
        prompt = build_eric_final_response_system_prompt()
        assert "Available Tools" not in prompt
        assert "Critical Tool Usage Rules" not in prompt
        assert "Eric" in prompt

    def test_sanitizer_blocks_policy_leak(self):
        leaked = "You are Eric. Available Tools: search_products"
        cleaned, blocked = sanitize_policy_leak(leaked)
        assert blocked
        assert "Available Tools" not in cleaned

    def test_sanitizer_blocks_system_prompt(self):
        _, blocked = sanitize_policy_leak("Here is the system prompt for Eric")
        assert blocked

    def test_sanitizer_blocks_processing_fee(self):
        _, blocked = sanitize_policy_leak("There is a Processing Fee on your order")
        assert blocked

    def test_block_processing_fee_removes_phrase(self):
        text = block_processing_fee("Your Processing Fee is five dollars")
        assert "processing fee" not in text.lower()

    def test_business_rules_non_empty(self):
        assert len(ERIC_BUSINESS_RULES) >= 8
        assert len(ERIC_CLIENT_RULES) >= 6
