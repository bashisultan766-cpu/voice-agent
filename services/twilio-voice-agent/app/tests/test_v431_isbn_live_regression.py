"""
v4.31 — Live call CA1255 ISBN regression fixes.
"""
from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.fast_greeting import fast_greeting_reply
from app.agent_runtime.isbn_short_circuit import (
    conversational_ack_reply,
    is_conversational_ack,
    resolve_spoken_isbn,
    try_isbn_short_circuit,
)
from app.agent_runtime.llm_tool_runtime import LLMToolRuntime
from app.agent_runtime.yes_engagement import yes_engagement_reply
from app.state.models import SessionState
from app.tools.isbn import expand_spoken_repeaters, extract_isbn_candidate
from app.voice.turn_assembler import TurnAssembler

SPOKEN_ISBN = "9 7 8 0 8 7 7 7 9 2 9 8 7."
GOOD_ISBN = "9780877792987"
TRIPLE_SEVEN = "The right 1 is 9 7 8 0 8 triple 7 9 2 9 8 7."


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="v431",
        call_sid="CA12558ddb4cf8079fa18677298f26ab56",
        from_number="+15551230000",
        to_number="+15559999999",
        **kwargs,
    )


class TestIsbnNormalization:
    def test_spoken_isbn_from_live_call(self):
        assert extract_isbn_candidate(SPOKEN_ISBN) == GOOD_ISBN

    def test_triple_seven_expansion(self):
        expanded = expand_spoken_repeaters(TRIPLE_SEVEN)
        isbn, _ = resolve_spoken_isbn(expanded)
        assert isbn == GOOD_ISBN


class TestYesEngagementEmptyCart:
    def test_bare_okay_gets_helpful_reply_not_payment_push(self):
        session = _session()
        reply = yes_engagement_reply(session)
        assert reply
        assert "payment link" not in reply.lower() or "find a book" in reply.lower()

    def test_conversational_ack_during_lookup(self):
        session = _session()
        session.pending_isbn_buffer = "97808777929"
        assert is_conversational_ack("Okay.")
        reply = conversational_ack_reply(session, turn_mode="isbn")
        assert reply
        assert "ISBN" in reply


class TestFastGreetingName:
    def test_rejects_stt_garbage_name(self):
        session = _session(caller_name="saying that?", twiml_greeting_spoken=True)
        reply = fast_greeting_reply(session, "how are you")
        assert reply
        assert "saying that" not in reply.lower()


class TestTurnAssemblerIsbnMode:
    @pytest.mark.asyncio
    async def test_wait_extend_merge_keeps_isbn_mode(self):
        asm = TurnAssembler()
        emitted: list = []

        async def on_emit(turn):
            emitted.append(turn)

        call_sid = "CA12558ddb4cf8079fa18677298f26ab56"
        await asm.ingest("I repeat the ISBN number again. Okay?", on_emit, call_sid=call_sid)
        await asm.ingest(
            "The ISBN number is 9 7 8 0 8 7 7 7 9 2 9 8 7.",
            on_emit,
            call_sid=call_sid,
        )
        await asm.flush(on_emit, call_sid=call_sid)

        assert emitted
        final = emitted[-1]
        assert final.mode == "isbn"
        assert "9780877792987" in "".join(c for c in final.text if c.isdigit())


class TestIsbnShortCircuit:
    @pytest.mark.asyncio
    async def test_complete_isbn_skips_openai(self):
        session = _session()
        book = {
            "title": "Test Book",
            "isbn": GOOD_ISBN,
            "variant_id": "gid://shopify/ProductVariant/1",
            "price": "12.99",
        }
        payload = json.dumps({"results": [book]})

        with patch(
            "app.agent_runtime.llm_tools._catalog_search",
            new_callable=AsyncMock,
            return_value=payload,
        ):
            result = await try_isbn_short_circuit(session, SPOKEN_ISBN, turn_mode="isbn")

        assert result is not None
        assert result.isbn == GOOD_ISBN
        assert "Test Book" in result.force_reply
        assert "copies" in result.force_reply.lower()

    @pytest.mark.asyncio
    async def test_runtime_short_circuits_isbn_turn(self):
        runtime = LLMToolRuntime()
        session = _session()
        book = {
            "title": "Live Book",
            "isbn": GOOD_ISBN,
            "variant_id": "gid://shopify/ProductVariant/9",
            "price": "9.99",
        }

        async def boom(*_a, **_k):
            raise AssertionError("OpenAI must not run on complete ISBN turn")

        runtime._complete = boom  # type: ignore[method-assign]

        with patch(
            "app.agent_runtime.llm_tools._catalog_search",
            new_callable=AsyncMock,
            return_value=json.dumps({"results": [book]}),
        ):
            async def send(_msg):
                pass

            out = await runtime.handle_turn(
                session,
                SPOKEN_ISBN,
                send,
                assembled_turn_mode="isbn",
            )

        assert "Live Book" in out.response_text

    def test_partial_isbn_buffers_digits(self):
        session = _session()
        isbn, buf = resolve_spoken_isbn("9 7 8 0 8 7 7 7 9 2 9", session=session, turn_mode="isbn")
        assert isbn is None
        assert len(buf) == 11
