"""v4.10 — Eric prompt compiler tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.brain.eric_prompt_compiler import (
    compile_brain_system_prompt,
    compile_brain_user_prompt,
    compile_composer_policy_excerpt,
)
from app.safety.response_sanitizer import sanitize_customer_response
from app.state.models import SessionState


def _session() -> SessionState:
    return SessionState(
        session_id="prompt", call_sid="CA_PR01",
        from_number="+15551234567", to_number="+18005551234",
    )


class TestEricPromptCompiler:
    def test_brain_prompt_identity_and_domain(self):
        p = compile_brain_system_prompt()
        assert "Eric" in p
        assert "SureShot Books" in p

    def test_brain_prompt_politics_boundary(self):
        p = compile_brain_system_prompt()
        assert "politics" in p.lower() or "sports" in p.lower()

    def test_no_available_tools_heading(self):
        p = compile_brain_user_prompt("Hello", "greeting", _session())
        assert "Available Tools" not in p

    def test_composer_excerpt_safe(self):
        p = compile_composer_policy_excerpt()
        assert "Available Tools" not in p
        assert "search_products" not in p.lower()

    def test_sanitizer_blocks_prompt_text(self):
        r = sanitize_customer_response(
            "Available Tools: search_products",
            intent="unknown",
            call_sid="CA",
        )
        assert "Available Tools" not in r.text
