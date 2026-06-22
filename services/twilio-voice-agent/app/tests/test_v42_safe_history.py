"""
v4.2 tests — ConversationHistory safe history management.

Verifies:
- Never stores role=tool or tool_calls.
- clear_inflight_turn() discards partial state.
- snapshot_for_composer() returns only safe messages.
- System message replacement works.
- Max turns trimming.
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.conversation.history import ConversationHistory


class TestConversationHistoryBasics:
    def test_empty_history(self):
        h = ConversationHistory()
        assert h.snapshot_for_composer() == []
        assert len(h) == 0

    def test_set_system(self):
        h = ConversationHistory()
        h.set_system("You are Eric.")
        snap = h.snapshot_for_composer()
        assert len(snap) == 1
        assert snap[0]["role"] == "system"
        assert snap[0]["content"] == "You are Eric."

    def test_set_system_replaces_existing(self):
        h = ConversationHistory()
        h.set_system("Old system.")
        h.set_system("New system.")
        snap = h.snapshot_for_composer()
        sys_msgs = [m for m in snap if m["role"] == "system"]
        assert len(sys_msgs) == 1
        assert sys_msgs[0]["content"] == "New system."

    def test_add_assistant_text_commits_user_and_assistant(self):
        h = ConversationHistory()
        h.add_user_turn("Hello")
        h.add_assistant_text("Hi there!")
        snap = h.snapshot_for_composer()
        roles = [m["role"] for m in snap]
        assert "user" in roles
        assert "assistant" in roles

    def test_clear_inflight_discards_partial(self):
        h = ConversationHistory()
        h.add_user_turn("How much does that cost?")
        # Caller interrupts before assistant responds
        h.clear_inflight_turn()
        # History should not have the user message committed
        snap = h.snapshot_for_composer()
        user_msgs = [m for m in snap if m["role"] == "user"]
        assert len(user_msgs) == 0

    def test_clear_inflight_multiple_times(self):
        """Multiple interruptions should not corrupt history."""
        h = ConversationHistory()
        h.set_system("You are Eric.")
        h.add_user_turn("First turn")
        h.add_assistant_text("Response 1")
        h.add_user_turn("Second turn (interrupted)")
        h.clear_inflight_turn()
        h.add_user_turn("Second turn (retry)")
        h.add_assistant_text("Response 2")

        snap = h.snapshot_for_composer()
        # Should have: system, user, assistant, user, assistant
        non_system = [m for m in snap if m["role"] != "system"]
        assert len(non_system) == 4

    def test_snapshot_excludes_tool_messages(self):
        """Even if somehow a tool message got in, snapshot must exclude it."""
        h = ConversationHistory()
        # Directly inject a tool message (should not happen in production)
        h._messages.append({"role": "tool", "content": "tool result", "tool_call_id": "abc"})
        h._messages.append({"role": "assistant", "content": None, "tool_calls": [{"id": "abc"}]})
        snap = h.snapshot_for_composer()
        for m in snap:
            assert m.get("role") != "tool"
            assert "tool_calls" not in m

    def test_snapshot_excludes_tool_calls_on_assistant(self):
        h = ConversationHistory()
        h._messages.append({
            "role": "assistant",
            "content": None,
            "tool_calls": [{"id": "call_abc", "function": {"name": "foo"}}],
        })
        snap = h.snapshot_for_composer()
        # message with no content is excluded by snapshot_for_composer (content is None)
        for m in snap:
            assert "tool_calls" not in m


class TestConversationHistoryTrimming:
    def test_trims_to_max_turns(self):
        from app.conversation.history import _MAX_TURNS
        h = ConversationHistory()
        h.set_system("You are Eric.")
        # Add more than _MAX_TURNS user/assistant pairs
        for i in range(_MAX_TURNS + 5):
            h.add_user_turn(f"Turn {i}")
            h.add_assistant_text(f"Response {i}")

        snap = h.snapshot_for_composer()
        non_system = [m for m in snap if m["role"] != "system"]
        assert len(non_system) <= _MAX_TURNS

    def test_system_message_always_kept(self):
        from app.conversation.history import _MAX_TURNS
        h = ConversationHistory()
        h.set_system("Keep this.")
        for i in range(_MAX_TURNS + 5):
            h.add_user_turn(f"Turn {i}")
            h.add_assistant_text(f"Response {i}")

        snap = h.snapshot_for_composer()
        sys_msgs = [m for m in snap if m["role"] == "system"]
        assert len(sys_msgs) == 1
        assert sys_msgs[0]["content"] == "Keep this."
