"""v4.6 tests — call memory (50-turn working memory)."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")

from app.conversation.call_memory import (
    CallMemoryState,
    build_composer_context,
    get_call_memory,
    record_assistant_turn,
    record_isbn,
    record_user_turn,
    sync_from_session,
)
from app.state.models import SessionState


def _session() -> SessionState:
    return SessionState(
        session_id="s-mem", call_sid="CA_MEM01",
        from_number="+15551234567", to_number="+18005551234",
    )


class TestCallMemoryRetention:
    def test_50_user_turns_retained(self):
        s = _session()
        for i in range(55):
            record_user_turn(s, f"turn number {i}")
        state = get_call_memory(s)
        assert len(state.user_turns) == 50

    def test_first_isbn_remembered_after_40_turns(self):
        s = _session()
        record_isbn(s, "9780140449112")
        for i in range(40):
            record_user_turn(s, f"filler question {i}")
        state = get_call_memory(s)
        assert "9780140449112" in state.isbns_provided

    def test_email_remembered_after_40_turns(self):
        s = _session()
        s.confirmed_email = "test@example.com"
        sync_from_session(s)
        for i in range(40):
            record_user_turn(s, f"filler {i}")
        state = get_call_memory(s)
        assert state.email_state == "confirmed"

    def test_no_tool_roles_in_memory(self):
        s = _session()
        record_user_turn(s, "hello")
        record_assistant_turn(s, "Hi there")
        state = get_call_memory(s)
        assert all("tool" not in t for t in state.user_turns)

    def test_rolling_summary_after_many_turns(self):
        s = _session()
        for i in range(20):
            record_user_turn(s, f"question {i}")
            record_assistant_turn(s, f"answer {i}")
        state = get_call_memory(s)
        assert len(state.user_turns) == 20
        assert state.rolling_summary or len(state.user_turns) <= 12

    def test_composer_context_includes_isbns(self):
        s = _session()
        s.isbn_history = ["978111", "978222"]
        sync_from_session(s)
        ctx = build_composer_context(s)
        assert "978111" in ctx

    def test_cart_not_cleared_by_topic_switch(self):
        s = _session()
        s.isbn_history = ["978111"]
        from app.cart.session import get_ledger, sync_ledger_to_session
        from app.cart.candidate import save_product_candidate
        save_product_candidate(s, title="Book", isbn="978111", variant_id="gid://1")
        ledger = get_ledger(s)
        ledger.confirm_last_candidate()
        sync_ledger_to_session(s, ledger)
        record_user_turn(s, "what is your store name")
        sync_from_session(s)
        assert get_ledger(s).confirmed_count() == 1
