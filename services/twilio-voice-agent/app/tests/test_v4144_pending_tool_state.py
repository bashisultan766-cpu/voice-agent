"""v4.14.4 — Pending tool state tests."""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


class TestPendingToolState:
    def test_status_query_detection(self):
        from app.agent_runtime.pending_tool_state import is_pending_tool_status_query

        assert is_pending_tool_status_query("Did you find this?")
        assert is_pending_tool_status_query("Any update?")
        assert not is_pending_tool_status_query("ISBN is 9780441172719")

    def test_running_response(self):
        from app.agent_runtime.pending_tool_state import (
            handle_pending_tool_status_query,
            start_pending_tool,
        )

        start_pending_tool("CA4144PEND", "isbn_lookup", ["isbn_lookup"], {"isbn": "123"})
        reply = handle_pending_tool_status_query("CA4144PEND", "Did you find it?")
        assert reply == "I'm still checking that. One moment."

    def test_completed_repeats_answer(self):
        from app.agent_runtime.pending_tool_state import (
            complete_pending_tool,
            handle_pending_tool_status_query,
            start_pending_tool,
        )

        start_pending_tool("CA4144DONE", "isbn_lookup", ["isbn_lookup"], {})
        complete_pending_tool(
            "CA4144DONE",
            facts_summary="1 fact",
            last_tool_answer="I found Dune. Would you like to add it?",
        )
        reply = handle_pending_tool_status_query("CA4144DONE", "Did you find this?")
        assert "Dune" in reply

    def test_failed_response(self):
        from app.agent_runtime.pending_tool_state import (
            fail_pending_tool,
            handle_pending_tool_status_query,
            start_pending_tool,
        )

        start_pending_tool("CA4144FAIL", "order_lookup", ["order_lookup"], {})
        fail_pending_tool("CA4144FAIL", reason="timeout")
        reply = handle_pending_tool_status_query("CA4144FAIL", "What happened?")
        assert "trouble checking" in reply.lower()

    def test_no_pending_returns_none(self):
        from app.agent_runtime.pending_tool_state import handle_pending_tool_status_query

        assert handle_pending_tool_status_query("CA4144NONE", "Did you find this?") is None
