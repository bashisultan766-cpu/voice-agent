"""v4.11 — Call memory manager tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


def _session():
    from app.state.models import SessionState
    return SessionState(
        session_id="s411mem",
        call_sid="CA00000415",
        from_number="+15550005555",
        to_number="+15559998888",
    )


class TestCallMemoryManager:
    def test_50_turn_memory_available(self):
        from app.agent_runtime.call_memory_manager import CallMemoryManager
        from app.conversation.call_memory import record_user_turn, record_assistant_turn

        session = _session()
        for i in range(55):
            record_user_turn(session, f"User turn {i}")
            record_assistant_turn(session, f"Agent turn {i}")

        packet = CallMemoryManager.build_packet(session, max_turns=50)
        assert len(packet.recent_turns) <= 50
        from app.conversation.call_memory import get_call_memory
        assert len(get_call_memory(session).user_turns) == 50

    def test_books_remembered_after_filler(self):
        from app.agent_runtime.call_memory_manager import CallMemoryManager
        from app.conversation.call_memory import record_isbn, record_user_turn

        session = _session()
        record_isbn(session, "9788893960648")
        for i in range(40):
            record_user_turn(session, f"Filler turn {i}")

        packet = CallMemoryManager.build_packet(session)
        assert "9788893960648" in packet.isbns

    def test_email_remembered(self):
        from app.agent_runtime.call_memory_manager import CallMemoryManager

        session = _session()
        session.pending_email = "test@example.com"
        from app.conversation.call_memory import sync_email_state
        sync_email_state(session)

        packet = CallMemoryManager.build_packet(session)
        assert packet.email_state in ("pending", "confirmed")

    def test_payment_remembered(self):
        from app.agent_runtime.call_memory_manager import CallMemoryManager

        session = _session()
        session.payment_flow_status = "awaiting_send_confirmation"
        packet = CallMemoryManager.build_packet(session)
        assert packet.payment_state == "awaiting_send_confirmation"

    def test_no_pii_in_logs(self):
        from app.agent_runtime.call_memory_manager import CallMemoryManager
        masked = CallMemoryManager.safe_log_text(
            "My email is john.doe@example.com and phone 555-123-4567"
        )
        assert "john.doe" not in masked
        assert "555-123" not in masked

    def test_i_already_told_you_repair_context(self):
        from app.agent_runtime.call_memory_manager import CallMemoryManager
        from app.conversation.call_memory import record_user_turn, record_isbn

        session = _session()
        record_isbn(session, "9781234567890")
        record_user_turn(session, "I already told you my ISBN")

        packet = CallMemoryManager.build_packet(session)
        assert packet.isbns
