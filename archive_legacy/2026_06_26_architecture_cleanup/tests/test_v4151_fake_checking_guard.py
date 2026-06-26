"""v4.15.1 — Fake checking guard tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")


class TestFakeCheckingGuard:
    def test_removes_fake_check_when_no_tools(self):
        from app.agent_runtime.fake_checking_guard import sanitize_fake_checking

        out = sanitize_fake_checking(
            "Let me check on that.",
            tool_started=False,
            intent="small_talk",
            context={"user_text": "How are you?"},
        )
        assert "let me check" not in out.lower()
        assert "help" in out.lower()

    def test_allows_checking_when_tools_started(self):
        from app.agent_runtime.fake_checking_guard import sanitize_fake_checking

        phrase = "Let me check on that for you."
        out = sanitize_fake_checking(
            phrase,
            tool_started=True,
            intent="book_search",
            context={},
        )
        assert out == phrase

    def test_memory_replacement(self):
        from app.agent_runtime.fake_checking_guard import sanitize_fake_checking

        out = sanitize_fake_checking(
            "Let me look that up.",
            tool_started=False,
            intent="memory_question",
            context={"user_text": "Do you remember me?"},
        )
        assert "let me" not in out.lower() or "help" in out.lower()
        assert "details" in out.lower() or "help" in out.lower()

    def test_cart_context_unknown(self):
        from app.agent_runtime.fake_checking_guard import sanitize_fake_checking

        out = sanitize_fake_checking(
            "Let me check on that.",
            tool_started=False,
            intent="unknown",
            context={"has_cart": True},
        )
        assert "cart" in out.lower() or "order" in out.lower()
