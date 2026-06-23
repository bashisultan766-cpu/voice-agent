"""
v4.10 live-call regression tests (production log replay).
"""
from __future__ import annotations

import asyncio
import logging
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.brain.eric_dialogue_brain import EricDialogueBrain, get_dialogue_brain
from app.cart.candidate import save_product_candidate
from app.composer.main_llm_composer import MainLLMComposer, _deterministic_response
from app.dialogue.short_utterance_resolver import resolve_short_utterance
from app.pipeline.compound_intent import detect
from app.pipeline.response_guard import apply_response_guard
from app.pipeline.router import IntentResult
from app.safety.response_sanitizer import sanitize_customer_response
from app.state.models import SessionState
from app.workers.orchestrator import WorkerOrchestrator


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="live410", call_sid="CA_LIVE410",
        from_number="+15551234567", to_number="+18005551234",
        twiml_greeting_spoken=True,
        **kwargs,
    )


def _settings():
    from app.config import Settings
    return Settings(
        OPENAI_API_KEY="test",
        DEBUG=True,
        VOICE_FILLER_AFTER_MS=0,
        VOICE_LLM_BRAIN_ENABLED=True,
        VOICE_LLM_BRAIN_TIMEOUT_MS=1800,
    )


async def _brain_intent(session: SessionState, text: str) -> str:
    router = detect(text, session)
    short = resolve_short_utterance(text, session, input_intent=router.intent)
    brain = get_dialogue_brain(_settings())
    decision = await brain.plan(
        session, text, router.intent,
        short_resolved_intent=short.intent if short.resolved else "",
    )
    session.last_brain_decision = decision
    return decision.intent


async def _full_response(session: SessionState, text: str) -> str:
    intent = await _brain_intent(session, text)
    ir = IntentResult(intent=intent, confidence=0.95, entities={"intent": intent})
    orch = WorkerOrchestrator()
    await orch.run(ir, session, _settings())
    text_out = _deterministic_response(session, ir)
    if not text_out:
        text_out = apply_response_guard(
            "", intent, call_sid=session.call_sid,
            response_plan=getattr(session, "response_plan", None),
        )
    return sanitize_customer_response(text_out, intent=intent, call_sid=session.call_sid).text


class TestV410LiveLogRegression:
    @pytest.mark.asyncio
    async def test_01_hello_how_are_you(self):
        s = _session(resume_greeting_delivered=True)
        intent = await _brain_intent(s, "Hello. How are you?")
        assert intent == "small_talk"
        resp = await _full_response(_session(resume_greeting_delivered=True), "Hello. How are you?")
        assert resp
        assert "doing well" in resp.lower() or "good" in resp.lower()

    @pytest.mark.asyncio
    async def test_02_identity_eric(self):
        intent = await _brain_intent(_session(), "What is your name?")
        assert intent == "identity_question"
        resp = await _full_response(_session(), "What is your name?")
        assert "Eric" in resp
        assert "SureShot Books" in resp

    @pytest.mark.asyncio
    async def test_03_repeated_identity(self):
        s = _session()
        for _ in range(2):
            resp = await _full_response(s, "What is your name?")
            assert resp
            assert "Eric" in resp

    @pytest.mark.asyncio
    async def test_04_hello_keepalive(self):
        intent = await _brain_intent(_session(), "Hello?")
        assert intent == "keepalive_question"
        resp = await _full_response(_session(), "Hello?")
        assert "here" in resp.lower()

    @pytest.mark.asyncio
    async def test_05_is_your_name_no_timeout(self):
        brain = EricDialogueBrain(settings=_settings())
        with patch("app.brain.eric_dialogue_brain._call_llm_brain", new_callable=AsyncMock) as mock_llm:
            decision = await brain.plan(_session(), "Is your name?", "unknown")
        mock_llm.assert_not_called()
        assert decision.intent == "identity_question"
        resp = await _full_response(_session(), "Is your name?")
        assert resp

    @pytest.mark.asyncio
    async def test_06_job_question_no_timeout(self):
        brain = EricDialogueBrain(settings=_settings())
        with patch("app.brain.eric_dialogue_brain._call_llm_brain", new_callable=AsyncMock) as mock_llm:
            decision = await brain.plan(_session(), "Okay. And so what is your job?", "unknown")
        mock_llm.assert_not_called()
        assert decision.intent == "job_question"
        resp = await _full_response(_session(), "Okay. And so what is your job?")
        assert "SureShot Books" in resp

    def test_07_vague_book_no_search(self):
        r = detect("I need a book. Can you please provide")
        assert r.intent == "vague_book_request"
        s = _session()
        item = save_product_candidate(
            s, title="How to Start a Vending Business", variant_id="gid://1",
            source_intent="vague_book_request", source_query="I need a book",
        )
        assert item is None

    @pytest.mark.asyncio
    async def test_08_fragmented_isbn(self):
        from app.tests.test_v49_turn_assembler import _settings as asm_settings
        from app.voice.turn_assembler import TurnAssembler

        asm = TurnAssembler(settings=asm_settings())
        emitted: list[str] = []

        async def on_emit(text: str) -> None:
            emitted.append(text)

        await asm.ingest("the ISBN number is 9 7 9 8 8.", on_emit, call_sid="CA08")
        await asm.ingest("9 3 9.", on_emit, call_sid="CA08")
        await asm.ingest("6 0 6 4 8.", on_emit, call_sid="CA08")
        await asyncio.sleep(0.25)
        assert len(emitted) >= 1
        digits = "".join(c for c in emitted[-1] if c.isdigit())
        assert len(digits) == 13
        r = detect(emitted[-1])
        assert r.intent == "isbn_search"
        assert r.entities.get("isbn")

    @pytest.mark.asyncio
    async def test_09_off_domain_trump(self):
        intent = await _brain_intent(_session(), "Who is Donald Trump?")
        assert intent == "out_of_domain_question"
        resp = await _full_response(_session(), "Who is Donald Trump?")
        assert "SureShot Books" in resp
        assert "trump" not in resp.lower()

    @pytest.mark.asyncio
    async def test_10_books_about_trump_search_allowed(self):
        intent = await _brain_intent(_session(), "Do you have books about Donald Trump?")
        assert intent == "topic_book_search_offer"
        s = _session()
        item = save_product_candidate(
            s, title="Some Book", variant_id="gid://1",
            source_intent="topic_book_search_offer",
            source_query="books about Donald Trump",
        )
        assert item is None

    @pytest.mark.asyncio
    async def test_brain_timeout_fast_fallback(self):
        brain = EricDialogueBrain(settings=_settings())
        with patch(
            "app.brain.eric_dialogue_brain._call_llm_brain",
            side_effect=asyncio.TimeoutError(),
        ):
            with patch(
                "app.brain.eric_dialogue_brain._fast_path_decision",
                return_value=None,
            ):
                decision = await brain.plan(_session(), "random gibberish xyz", "unknown")
        assert decision.source == "fallback"

    def test_no_processing_fee_in_responses(self):
        r = sanitize_customer_response(
            "There is a Processing Fee on your order.",
            intent="unknown", call_sid="CA",
        )
        assert "Processing Fee" not in r.text
