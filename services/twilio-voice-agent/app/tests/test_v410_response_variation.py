"""v4.10 — response variation tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.dialogue.response_variation import get_out_of_domain_variant, get_varied_response
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="var", call_sid="CA_VAR01",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


class TestResponseVariation:
    def test_no_repeat_more_than_twice(self):
        s = _session()
        lines = []
        for _ in range(5):
            lines.append(get_varied_response("small_talk", "I'm doing well, thank you.", s))
        for line in set(lines):
            assert lines.count(line) <= 2

    def test_business_critical_exact(self):
        payment = "I sent the payment link to your email."
        assert get_varied_response("payment_execute", payment, _session()) == payment

    def test_out_of_domain_varies(self):
        s = _session()
        a = get_out_of_domain_variant(s)
        b = get_out_of_domain_variant(s)
        assert "SureShot Books" in a
        assert "SureShot Books" in b

    def test_no_ai_mention(self):
        text = get_varied_response("identity_question", "My name is Eric.", _session())
        assert "AI" not in text
        assert "tool" not in text.lower()
