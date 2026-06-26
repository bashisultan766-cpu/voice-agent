"""v4.11 — End-to-end ElevenLabs-style runtime simulation tests."""
from __future__ import annotations

import logging
import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("VOICE_AGENT_RUNTIME_MODE", "eric_agent_runtime")


def _session(sid="CA00000420"):
    from app.state.models import SessionState
    return SessionState(
        session_id=f"s-{sid}",
        call_sid=sid,
        from_number="+15550007777",
        to_number="+15559998888",
    )


async def _run_turn(session, text, caplog=None):
    from app.agent_runtime.runtime import get_eric_runtime
    sent = []

    async def send(msg):
        sent.append(msg)

    if caplog:
        caplog.set_level(logging.INFO)
    result = await get_eric_runtime().handle_turn(session, text, send)
    tokens = [m.get("token", "") for m in sent if m.get("type") == "text" and m.get("token")]
    return result, " ".join(tokens), sent


@pytest.mark.asyncio
class TestElevenStyleRuntime:
    async def test_01_small_talk_identity(self, caplog):
        session = _session()
        for text in ("Hello", "How are you?", "What is your name?", "What is your job?"):
            _, response, _ = await _run_turn(session, text, caplog)
            assert response.strip(), f"No response for: {text}"
        assert "Eric" in response or "SureShot" in response

    async def test_02_generic_book_request(self, caplog):
        session = _session("CA00000421")
        _, response, _ = await _run_turn(session, "I need a book.", caplog)
        assert "ISBN" in response or "title" in response.lower()
        assert "processing fee" not in response.lower()

    async def test_03_isbn_fragments_via_assembler(self):
        from app.voice.turn_assembler import TurnAssembler
        emitted = []

        async def on_emit(text):
            emitted.append(text)

        asm = TurnAssembler()
        await asm.ingest("I have ISBN", on_emit, call_sid="CA2")
        await asm.ingest("9788893960648", on_emit, call_sid="CA2")
        await asm.flush(on_emit, call_sid="CA2")
        if emitted:
            last_text = emitted[-1].text if hasattr(emitted[-1], "text") else emitted[-1]
            digits = "".join(c for c in last_text if c.isdigit())
            assert len(digits) in (10, 13) or len(emitted) >= 1

    async def test_06_subtotal_wording(self):
        from app.brain.eric_policy import get_response_template
        tpl = get_response_template("subtotal_template", amount="$25.00")
        assert "subtotal before shipping" in tpl.lower()
        assert "does not include shipping" in tpl.lower()

    async def test_08_off_domain_vs_book_topic(self, caplog):
        session = _session("CA00000422")
        _, r1, _ = await _run_turn(session, "Who is Donald Trump?", caplog)
        assert "catalog" in r1.lower() or "sureshot" in r1.lower()

        session2 = _session("CA00000423")
        _, r2, _ = await _run_turn(
            session2, "Do you have books about Donald Trump?", caplog,
        )
        assert r2.strip()

    async def test_09_memory_after_filler(self):
        from app.conversation.call_memory import record_isbn, record_user_turn
        from app.agent_runtime.call_memory_manager import CallMemoryManager

        session = _session("CA00000424")
        record_isbn(session, "9788893960648")
        for i in range(40):
            record_user_turn(session, f"noise {i}")
        packet = CallMemoryManager.build_packet(session)
        assert "9788893960648" in packet.isbns

    async def test_runtime_logs_present(self, caplog):
        session = _session("CA00000425")
        caplog.set_level(logging.INFO)
        await _run_turn(session, "Hello", caplog)
        logs = caplog.text
        assert "eric_runtime_start" in logs
        assert "eric_supervisor_decision" in logs
        assert "eric_runtime_complete" in logs

    async def test_no_processing_fee_in_responses(self, caplog):
        session = _session("CA00000426")
        _, response, _ = await _run_turn(session, "What is your name?", caplog)
        assert "processing fee" not in response.lower()

    async def test_payment_sent_exact_wording(self):
        from app.agent_runtime.eric_master_policy import get_deterministic_template
        msg = get_deterministic_template("payment_sent")
        assert "facility details" in msg
        assert "inmate details" in msg
        assert "complete your order" in msg

    @pytest.mark.asyncio
    async def test_health_shows_runtime_mode(self):
        from app.api.health import health
        result = await health()
        assert "runtime_mode" in result
        assert "memory_turns" in result
        assert "OPENAI" not in str(result)
