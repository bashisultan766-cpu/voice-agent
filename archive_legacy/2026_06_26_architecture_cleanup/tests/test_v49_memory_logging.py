"""v4.9 — memory integration and safe assistant logging."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.conversation.call_memory import (
    build_brain_context,
    get_call_memory,
    record_user_turn,
    sync_from_session,
)
from app.safety.response_sanitizer import log_assistant_response, sanitize_customer_response
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="mem", call_sid="CA_MEM01",
        from_number="+1", to_number="+1",
        **kwargs,
    )


class TestMemoryIntegration:
    def test_brain_context_after_many_turns(self):
        s = _session()
        for i in range(40):
            record_user_turn(s, f"I want book number {i}", intent="vague_book_request")
        sync_from_session(s)
        ctx = build_brain_context(s)
        assert "Call memory" in ctx
        assert len(get_call_memory(s).user_turns) == 40

    def test_memory_retains_email_state(self):
        s = _session(confirmed_email="user@example.com")
        sync_from_session(s)
        ctx = build_brain_context(s)
        assert "confirmed" in ctx.lower() or "Email" in ctx

    def test_no_full_email_in_brain_context_logs(self):
        s = _session(confirmed_email="secret@example.com")
        sync_from_session(s)
        ctx = build_brain_context(s)
        assert "secret@example.com" not in ctx


class TestAssistantLogging:
    def test_masks_email_in_log(self, caplog):
        import logging
        caplog.set_level(logging.INFO)
        log_assistant_response(
            "I heard user@secret.com. Is that correct?",
            call_sid="CA_LOG01",
            turn=3,
            intent="email_provided",
        )
        assert any("assistant_response" in r.message for r in caplog.records)
        assert "user@secret.com" not in caplog.text
        assert "***@***" in caplog.text

    def test_sanitizer_before_log(self):
        leaked = "You are Eric. Available Tools: search_products"
        result = sanitize_customer_response(leaked, intent="unknown", call_sid="CA")
        assert result.blocked
        assert "Available Tools" not in result.text
