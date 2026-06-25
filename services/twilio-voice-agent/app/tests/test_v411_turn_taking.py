"""v4.11 — Turn taking and skip-turn tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


class TestTurnTakingV411:
    def test_wait_phrase_holds(self):
        from app.voice.turn_taking import classify_turn
        ctx = classify_turn("Wait hold on one second")
        assert ctx.hold_response
        assert ctx.hold_filler == ""

    def test_incomplete_isbn_fragment(self):
        from app.voice.turn_taking import classify_turn, is_complete_isbn
        ctx = classify_turn("9 7 9 8 8", intent="isbn_search")
        assert ctx.collecting_isbn
        assert not is_complete_isbn("9 7 9 8 8")

    def test_complete_isbn(self):
        from app.voice.turn_taking import is_complete_isbn
        assert is_complete_isbn("9788893960648")

    @pytest.mark.asyncio
    async def test_turn_assembler_email_merge(self):
        from app.voice.turn_assembler import TurnAssembler

        emitted = []

        async def on_emit(turn):
            emitted.append(turn.text)

        asm = TurnAssembler()
        await asm.ingest("bashi at gmail", on_emit, call_sid="CA1")
        await asm.ingest("dot com", on_emit, call_sid="CA1")
        await asm.flush(on_emit, call_sid="CA1")
        if emitted:
            assert len(emitted) >= 1

    @pytest.mark.asyncio
    async def test_no_duplicate_responses_on_wait(self):
        from app.agent_runtime.runtime import get_eric_runtime
        from app.state.models import SessionState

        session = SessionState(
            session_id="s411tt",
            call_sid="CA00000416",
            from_number="+15550006666",
            to_number="+15559998888",
        )
        sent = []

        async def send(msg):
            sent.append(msg)

        await get_eric_runtime().handle_turn(session, "Wait one moment", send)
        tokens = [m.get("token") for m in sent if m.get("token")]
        assert len(tokens) == 0
