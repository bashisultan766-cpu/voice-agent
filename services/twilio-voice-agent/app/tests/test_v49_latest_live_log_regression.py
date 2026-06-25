"""
v4.9 live-call regression tests (production log replay).
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
from app.cart.session import confirm_last_candidate, get_ledger, sync_ledger_to_session
from app.composer.main_llm_composer import MainLLMComposer, _deterministic_response
from app.conversation.call_memory import check_and_apply_resume
from app.dialogue.manager import DialogueManager
from app.dialogue.short_utterance_resolver import resolve_short_utterance
from app.pipeline.compound_intent import detect
from app.pipeline.email_speller import build_email_readback, speak_email, spell_email_for_voice
from app.pipeline.engine import _apply_email_state, _apply_payment_state
from app.pipeline.router import IntentResult
from app.payment.scope_audit import audit_payment_scope
from app.safety.response_sanitizer import sanitize_customer_response
from app.state.models import SessionState
from app.workers.orchestrator import WorkerOrchestrator


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="live49", call_sid="CA_LIVE49",
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


class TestV49LiveLogRegression:
    """Replay latest live call sequence with v4.9 brain."""

    @pytest.mark.asyncio
    async def test_01_call_resume_applied(self):
        import time
        from unittest.mock import MagicMock
        prior = MagicMock()
        prior.call_sid = "OLD49"
        prior.call_ended_at = time.time() - 120
        prior.call_resume_snapshot = {
            "cart_count": 1,
            "payment_flow_status": "idle",
            "current_topic": "cart_building",
            "important_facts": ["Cart count: 1"],
        }
        prior.call_memory = None
        s = _session()
        assert check_and_apply_resume(s, prior, resume_window_minutes=30)
        assert s.resume_greeting_pending is True

    @pytest.mark.asyncio
    async def test_02_hello_how_are_you_small_talk(self):
        s = _session(
            is_resumed_call=True,
            resume_greeting_delivered=True,
        )
        intent = await _brain_intent(s, "Hello. How are you?")
        assert intent == "small_talk"
        ir = IntentResult(intent=intent, confidence=0.95)
        text = _deterministic_response(s, ir)
        assert "doing well" in text.lower()
        assert "sorry" not in text.lower()

    @pytest.mark.asyncio
    async def test_03_identity_eric(self):
        intent = await _brain_intent(_session(), "What is your name?")
        assert intent == "identity_question"
        text = _deterministic_response(
            _session(), IntentResult(intent=intent, confidence=0.95),
        )
        assert "Eric" in text

    @pytest.mark.asyncio
    async def test_04_where_from_sureshot(self):
        intent = await _brain_intent(_session(), "Where are you from?")
        assert intent in ("store_info_question", "company_origin_question")
        text = _deterministic_response(
            _session(), IntentResult(intent="store_info_question", confidence=0.95),
        )
        assert "SureShot Books" in text

    def test_05_vague_book(self):
        assert detect("I need a book.").intent == "vague_book_request"

    def test_06_isbn_collection(self):
        assert detect("I have the ISBN number.").intent == "isbn_collection_start"

    def test_07_isbn_search_candidate(self):
        r = detect("9 7 9 8 9 9 3 8 6 1 8 0 7.")
        assert r.intent == "isbn_search"
        assert r.entities.get("isbn") == "9798993861807"

    @pytest.mark.asyncio
    async def test_08_yes_add_to_cart(self):
        s = _session()
        save_product_candidate(
            s, title="Book 1", variant_id="gid://1",
            source_intent="isbn_search", isbn="9798993861807",
        )
        st = DialogueManager.get_state(s)
        st.active_flow = "cart_building"
        st.expected_next = "confirm_product"
        DialogueManager.set_state(s, st)
        short = resolve_short_utterance("Yes.", s)
        assert short.intent == "add_to_cart"

    def test_09_another_book(self):
        r = detect("I want to add another book.", _session())
        assert r.intent in ("another_book", "isbn_collection_start")

    def test_10_second_isbn(self):
        r = detect("The ISBN number is 9798994835500.")
        assert r.intent == "isbn_search"

    @pytest.mark.asyncio
    async def test_11_payment_not_product_search(self):
        s = _session()
        ledger = get_ledger(s)
        from app.cart.ledger import CartItem
        ledger.items.append(CartItem(
            title="Book A", variant_id="gid://1", isbn="9780000000001",
            quantity=1, confirmation_status="confirmed",
        ))
        sync_ledger_to_session(s, ledger)
        intent = await _brain_intent(
            s, "Send me the bill payment thing for these books.",
        )
        assert intent in ("send_payment_link", "payment_execute")
        assert intent != "product_search"

    def test_17_email_readback_exact(self):
        email = "bashisultan766@gmail.com"
        text = build_email_readback(email)
        assert text.startswith(f"I heard {speak_email(email)}.")
        assert spell_email_for_voice(email) in text
        assert text.endswith("Is that correct?")

    @pytest.mark.asyncio
    async def test_18_email_confirmation(self):
        s = _session(
            pending_email="bashisultan766@gmail.com",
            payment_flow_status="awaiting_email_confirmation",
        )
        short = resolve_short_utterance("Yes.", s)
        assert short.intent == "email_confirmation"

    @pytest.mark.asyncio
    async def test_19_payment_execute(self):
        s = _session(payment_flow_status="awaiting_send_confirmation")
        short = resolve_short_utterance("Yes, send it.", s)
        assert short.intent == "payment_execute"

    def test_20_ending_thanks(self):
        assert detect("Okay thank you.").intent == "ending_thanks"

    @pytest.mark.asyncio
    async def test_brain_decision_logged(self, caplog):
        caplog.set_level(logging.INFO)
        s = _session()
        await _brain_intent(s, "What is your name?")
        assert any("llm_brain_decision" in r.message for r in caplog.records)

    def test_no_processing_fee_in_sanitizer(self):
        result = sanitize_customer_response(
            "Your Processing Fee is five dollars.",
            intent="unknown",
        )
        assert result.blocked

    @pytest.mark.asyncio
    async def test_payment_scope_no_fee(self):
        s = _session()
        s.cart_items = [{
            "title": "Real Book",
            "variant_id": "gid://1",
            "quantity": 1,
            "confirmation_status": "confirmed",
        }]
        audit_items, audit = audit_payment_scope(s, {}, "")
        assert audit.checkout_count >= 1

    @pytest.mark.asyncio
    async def test_too_not_unknown(self):
        s = _session()
        st = DialogueManager.get_state(s)
        st.active_flow = "cart_building"
        DialogueManager.set_state(s, st)
        intent = await _brain_intent(s, "Too.")
        assert intent != "unknown"

    def test_resume_apology_only_once(self):
        s = _session(
            resume_greeting_pending=True,
            resume_greeting_delivered=False,
            resume_greeting="I'm sorry about that. Let me continue from where we left off.",
        )
        ir = IntentResult(intent="greeting", confidence=0.9)
        t1 = _deterministic_response(s, ir)
        assert "sorry" in t1.lower()
        ir2 = IntentResult(intent="small_talk", confidence=0.9)
        t2 = _deterministic_response(s, ir2)
        assert "sorry" not in t2.lower()
