"""v4.13 — Conversation state machine tests."""
from __future__ import annotations

import os
import time

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


@pytest.fixture(autouse=True)
def _clear_state():
    from app.agent_runtime.conversation_state_machine import clear_conversation_state
    clear_conversation_state("CA413SM")
    yield
    clear_conversation_state("CA413SM")


class TestConversationStateMachine:
    def test_isbn_mode_exits_on_hello(self):
        from app.agent_runtime.conversation_state_machine import (
            get_conversation_state, process_turn,
        )
        st = get_conversation_state("CA413SM")
        st.mode = "isbn_collection"
        st.pending_isbn_digits = "978044117271"
        r = process_turn("CA413SM", "Hello?", pipeline_intent="unknown", isbn_buffer="978044117271")
        assert r.exit_collection is True
        assert "here" in r.repair_response.lower()

    def test_isbn_mode_exits_on_frustration(self):
        from app.agent_runtime.conversation_state_machine import (
            get_conversation_state, process_turn,
        )
        st = get_conversation_state("CA413SM")
        st.mode = "isbn_collection"
        r = process_turn("CA413SM", "Why are you not responding?", pipeline_intent="unknown")
        assert r.exit_collection is True

    def test_twelve_digit_isbn_asks_for_last_digit(self, monkeypatch):
        from app.agent_runtime.conversation_state_machine import (
            get_conversation_state, process_turn,
        )
        monkeypatch.setenv("VOICE_ISBN_PARTIAL_TIMEOUT_MS", "1")
        from app.config import get_settings
        get_settings.cache_clear()
        st = get_conversation_state("CA413SM")
        st.mode = "isbn_collection"
        st.pending_isbn_digits = "978044117271"
        st.isbn_partial_since = time.monotonic() - 10
        r = process_turn("CA413SM", "", pipeline_intent="isbn_search", isbn_buffer="978044117271")
        assert "twelve digits" in r.repair_response.lower()

    def test_repeat_resets_isbn(self):
        from app.agent_runtime.conversation_state_machine import (
            get_conversation_state, process_turn,
        )
        st = get_conversation_state("CA413SM")
        st.mode = "isbn_collection"
        st.pending_isbn_digits = "978044117271"
        r = process_turn("CA413SM", "Sorry repeat again", pipeline_intent="unknown")
        assert r.clear_isbn_buffer is True

    def test_identity_inside_book_flow(self):
        from app.agent_runtime.conversation_state_machine import process_turn
        from app.agent_runtime.conversation_state_machine import get_conversation_state
        st = get_conversation_state("CA413SM")
        st.mode = "book_collection"
        r = process_turn("CA413SM", "Are you SureShot Books assistant?", pipeline_intent="company_question")
        assert r.state.mode == "book_collection"

    def test_what_repeats_last_response(self):
        from app.agent_runtime.conversation_state_machine import (
            get_conversation_state, process_turn, record_safe_response,
        )
        record_safe_response("CA413SM", "Yes, I'm Eric with SureShot Books.")
        r = process_turn("CA413SM", "What?", pipeline_intent="repeat_clarification")
        assert "Eric" in r.repair_response

    def test_wait_max_hold_sends_keepalive(self, monkeypatch):
        from app.agent_runtime.conversation_state_machine import (
            get_conversation_state, process_turn,
        )
        monkeypatch.setenv("VOICE_COLLECTION_MAX_HOLD_MS", "1")
        monkeypatch.setenv("VOICE_COLLECTION_KEEPALIVE_ENABLED", "true")
        from app.config import get_settings
        get_settings.cache_clear()
        st = get_conversation_state("CA413SM")
        st.hold_started_at = time.monotonic() - 10
        r = process_turn("CA413SM", "Wait. I will give you.", pipeline_intent="unknown")
        assert "here" in r.repair_response.lower()
