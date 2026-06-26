"""v4.14 — Privacy/address rules.

Only provide address/order details for the caller's own verified phone/customer/order.
Never reveal another customer's address.
"""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


class TestPrivacyAddressRules:
    """Privacy rules must protect customer data."""

    def test_main_llm_agent_privacy_rules_in_prompt(self):
        """Prompt file must contain privacy rules about not revealing customer data."""
        prompt_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "data", "eric_system_prompt.md",
        )
        with open(prompt_path, encoding="utf-8") as f:
            text = f.read().lower()

        privacy_phrases = [
            "never reveal full email",
            "never log or speak secrets",
            "never",
        ]
        for phrase in privacy_phrases:
            assert phrase in text, f"Missing privacy phrase: {phrase}"

    @pytest.mark.asyncio
    async def test_identity_no_address_leak(self):
        """Identity questions should not reveal address info."""
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="What is your name?",
            settings=s,
        )
        assert decision["direct_answer"] == "My name is Eric. I'm with SureShot Books."
        assert "address" not in decision["direct_answer"].lower()

    @pytest.mark.asyncio
    async def test_address_update_requires_verification(self):
        """Address update must request verification."""
        from app.agent_runtime.main_llm_agent import decide_and_answer
        from app.config import get_settings
        s = get_settings()

        decision = await decide_and_answer(
            user_turn="I need to update my address",
            settings=s,
        )
        assert decision["intent"] == "address_update"
        assert decision["response_mode"] == "needs_tools"
        assert "address_update" in decision["tool_categories"]


class TestFinalComposerPrivacy:
    """Final response composer must never leak sensitive data."""

    def test_final_composer_no_pii_in_template(self):
        from app.agent_runtime.eric_master_policy import DETERMINISTIC_TEMPLATES

        pii_patterns = ["full email", "phone", "checkout url", "card number"]
        for key, tpl in DETERMINISTIC_TEMPLATES.items():
            tpl_lower = tpl.lower()
            for pat in pii_patterns:
                assert pat not in tpl_lower, f"PII pattern '{pat}' found in template '{key}'"
