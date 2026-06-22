"""v4.7 unit tests — response sanitizer."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.safety.response_sanitizer import sanitize_customer_response


class TestResponseSanitizer:
    def test_system_prompt_blocked(self):
        leak = "You are Eric, the professional AI voice support agent for SureShot Books."
        r = sanitize_customer_response(leak, intent="unknown", call_sid="CA123")
        assert r.blocked
        assert "Eric" not in r.text or "professional AI" not in r.text
        assert "How can I help" in r.text

    def test_available_tools_blocked(self):
        r = sanitize_customer_response("Here are the Available Tools for this call.", call_sid="CA")
        assert r.blocked

    def test_tool_names_blocked(self):
        for leak in ("Use GetOrder now", "SureShotCatalogSearch returned", "SendPaymentLink"):
            r = sanitize_customer_response(leak, call_sid="CA")
            assert r.blocked, leak

    def test_headings_blocked(self):
        r = sanitize_customer_response("# Voice Style\nSpeak calmly.", call_sid="CA")
        assert r.blocked

    def test_safe_response_passes(self):
        safe = "The first book you added is Raising Telepathic Children."
        r = sanitize_customer_response(safe, call_sid="CA")
        assert not r.blocked
        assert r.text == safe

    def test_thanks_intent_fallback(self):
        leak = "You are Eric. Available Tools include SendPaymentLink."
        r = sanitize_customer_response(leak, intent="ending_thanks", call_sid="CA")
        assert r.blocked
        assert "Thank you for calling SureShot Books" in r.text

    def test_payment_sent_fallback(self):
        leak = "Critical Tool Usage Rules apply here."
        r = sanitize_customer_response(
            leak, intent="payment_execute", payment_sent=True, call_sid="CA",
        )
        assert r.blocked
        assert "payment link" in r.text.lower()
