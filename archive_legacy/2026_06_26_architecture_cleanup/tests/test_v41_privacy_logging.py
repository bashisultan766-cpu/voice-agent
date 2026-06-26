"""
v4.1 tests — privacy/logging: phone masking, email masking, secret guarding.
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")


class TestMaskPhone:
    def test_us_phone_masked(self):
        from app.ws.conversation_relay import _mask_phone
        assert _mask_phone("+15005550006") == "***0006"

    def test_ten_digit_masked(self):
        from app.ws.conversation_relay import _mask_phone
        assert _mask_phone("5005550123") == "***0123"

    def test_empty_string(self):
        from app.ws.conversation_relay import _mask_phone
        assert _mask_phone("") == "***"

    def test_none_handled(self):
        from app.ws.conversation_relay import _mask_phone
        assert _mask_phone(None) == "***"

    def test_short_number(self):
        from app.ws.conversation_relay import _mask_phone
        # only 3 digits — no last-4
        assert _mask_phone("123") == "***"

    def test_returns_last_four_only(self):
        from app.ws.conversation_relay import _mask_phone
        result = _mask_phone("+12125551234")
        assert result == "***1234"
        assert "2125551234" not in result


class TestMaskEmailPaymentWorker:
    def test_mask_email_typical(self):
        from app.workers.payment_email_worker import _mask_email
        assert _mask_email("alice@example.com") == "a***@example.com"

    def test_mask_email_short_local(self):
        from app.workers.payment_email_worker import _mask_email
        assert _mask_email("a@example.com") == "***@example.com"

    def test_mask_email_no_at(self):
        from app.workers.payment_email_worker import _mask_email
        assert _mask_email("notanemail") == "***@***"

    def test_mask_email_empty(self):
        from app.workers.payment_email_worker import _mask_email
        assert _mask_email("") == "***@***"


class TestMaskEmailRefundWorker:
    def test_mask_email(self):
        from app.workers.refund_worker import _mask_email
        masked = _mask_email("jessica@sureshotbooks.com")
        assert masked.startswith("j***@")
        assert "jessica" not in masked

    def test_empty_returns_empty(self):
        from app.workers.refund_worker import _mask_email
        assert _mask_email("") == ""


class TestSystemPromptNoSecrets:
    def test_no_api_key_in_prompt(self):
        from app.ai.system_prompt import build_system_message
        msg = build_system_message()
        content = msg["content"]
        # Prompt must not contain anything that looks like a real token
        assert "sk-" not in content
        assert "OPENAI_API_KEY" not in content
        assert "SHOPIFY" not in content

    def test_prompt_does_not_mention_ai(self):
        from app.ai.system_prompt import build_system_message
        msg = build_system_message()
        content = msg["content"].lower()
        # The prompt must instruct NEVER to say "AI" — but the word appears in the rule
        # Check the rule is present
        assert "never say you are an ai" in content

    def test_prompt_forbids_processing_fee(self):
        from app.ai.system_prompt import build_system_message
        msg = build_system_message()
        assert "Processing Fee" in msg["content"] or "processing fee" in msg["content"].lower()
        # Confirm it's in a "never say" context
        assert "NEVER say" in msg["content"] or "never say" in msg["content"].lower()

    def test_agent_name_is_eric_by_default(self):
        from app.ai.system_prompt import build_system_message
        msg = build_system_message()
        assert "Eric" in msg["content"]

    def test_agent_name_override(self):
        from app.ai.system_prompt import build_system_message
        msg = build_system_message(agent_name="Sam")
        assert "Sam" in msg["content"]

    def test_sureshot_books_mentioned(self):
        from app.ai.system_prompt import build_system_message
        msg = build_system_message()
        assert "SureShot Books" in msg["content"]

    def test_facility_context_present(self):
        from app.ai.system_prompt import build_system_message
        msg = build_system_message()
        assert "facility" in msg["content"].lower()
        assert "incarcerated" in msg["content"].lower()

    def test_confirmed_email_rule_present(self):
        from app.ai.system_prompt import build_system_message
        msg = build_system_message()
        content = msg["content"].lower()
        assert "confirmed" in content
        assert "email" in content
