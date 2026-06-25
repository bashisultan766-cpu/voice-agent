"""
v4.7 live-call regression tests (production log replay).
"""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.cart.candidate import save_product_candidate
from app.cart.session import get_ledger, confirm_last_candidate, sync_ledger_to_session
from app.composer.main_llm_composer import MainLLMComposer
from app.dialogue.manager import DialogueManager
from app.pipeline.compound_intent import detect
from app.pipeline.engine import _apply_email_state
from app.pipeline.router import IntentResult
from app.pipeline.email_speller import build_email_readback, spell_email_for_voice, speak_email
from app.payment.scope_audit import audit_payment_scope
from app.safety.response_sanitizer import sanitize_customer_response
from app.state.models import SessionState
from app.workers.orchestrator import WorkerOrchestrator


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="live47", call_sid="CA_LIVE47",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


def _settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True, VOICE_FILLER_AFTER_MS=0)


class TestV47LiveLogRegression:
    """Replay latest live call sequence with guardrails."""

    def test_01_vague_book(self):
        assert detect("I need a book.").intent == "vague_book_request"

    def test_02_isbn_collection(self):
        assert detect("I have the ISBN number.").intent == "isbn_collection_start"

    def test_03_first_isbn_search(self):
        r = detect("9 7 8 1 9 6 2 0 2 2 0 6 4.")
        assert r.intent == "isbn_search"
        assert r.entities.get("isbn") == "9781962022064"

    def test_07_memory_first_book_no_search(self):
        r = detect("What is the first book title?", session=_session())
        assert r.intent == "first_book_question"
        assert r.intent != "product_search"

    def test_08_which_book_first_no_search(self):
        r = detect("Which book I add first?", session=_session())
        assert r.intent == "first_book_question"

    def test_memory_no_candidate_saved(self):
        s = _session()
        get_ledger(s)  # init
        before = len(s.cart_items or [])
        save_product_candidate(
            s,
            title="The Recovery Book",
            variant_id="gid://bad",
            source_intent="first_book_question",
            source_query="What is the first book title?",
        )
        assert len(get_ledger(s).items) == before

    def test_10_send_both_payment_scope(self):
        s = _session()
        ledger = get_ledger(s)
        from app.cart.ledger import CartItem
        for isbn, title in (("9781962022064", "Book A"), ("9798998627002", "Book B")):
            ledger._items.append(CartItem(
                title=title, isbn=isbn, variant_id=f"gid://{isbn}",
                confirmation_status="confirmed", eligible_for_checkout=True,
                candidate_guard_allowed=True,
            ))
        sync_ledger_to_session(s, ledger)
        items, audit = audit_payment_scope(
            s, {"payment_scope": "both"}, "Send both books payment link.",
        )
        assert len(items) == 2
        assert audit.checkout_count == 2

    def test_11_email_provided(self):
        r = detect("My email is bashisultan766@gmail.com.")
        assert r.intent == "email_provided"
        assert "bashisultan766@gmail.com" in r.entities.get("email", "")

    def test_12_spell_email(self):
        s = _session(pending_email="bashisultan766@gmail.com",
                     payment_flow_status="awaiting_email_confirmation")
        assert detect("Letter by letter. Can you repeat?", s).intent == "spell_email_request"
        spell = DialogueManager.build_spell_email_response(s)
        assert spell_email_for_voice("bashisultan766@gmail.com") in spell
        assert speak_email("bashisultan766@gmail.com") in spell

    def test_13_email_confirm(self):
        s = _session(pending_email="bashisultan766@gmail.com",
                     payment_flow_status="awaiting_email_confirmation")
        ir = IntentResult(intent="email_confirmation", confidence=0.95, entities={})
        _apply_email_state(s, ir)
        assert s.confirmed_email == "bashisultan766@gmail.com"

    def test_15_ending_no_leak(self):
        ending = sanitize_customer_response(
            "You are Eric, the professional AI voice support agent. Available Tools...",
            intent="ending_thanks",
            call_sid="CA_LIVE47",
        )
        assert ending.blocked
        assert "SureShot Books" in ending.text
        assert "Available Tools" not in ending.text

    @pytest.mark.asyncio
    async def test_cart_build_two_books_confirm(self):
        s = _session()
        for isbn, title in (("9781962022064", "Raising Telepathic Children"), ("9798998627002", "Keep Talking")):
            save_product_candidate(
                s, title=title, isbn=isbn, variant_id=f"gid://{isbn}",
                source_intent="isbn_search",
            )
            confirm_last_candidate(s)
        assert get_ledger(s).confirmed_count() == 2

    @pytest.mark.asyncio
    async def test_payment_worker_scope_two_not_five(self):
        s = _session(confirmed_email="bashisultan766@gmail.com")
        ledger = get_ledger(s)
        from app.cart.ledger import CartItem
        for isbn, title in (("9781962022064", "A"), ("9798998627002", "B")):
            ledger._items.append(CartItem(
                title=title, isbn=isbn, variant_id=f"gid://{isbn}",
                confirmation_status="confirmed", eligible_for_checkout=True,
            ))
        for title in ("Blocked 1", "Blocked 2", "Blocked 3"):
            ledger._items.append(CartItem(
                title=title, variant_id=f"gid://x{title}",
                confirmation_status="confirmed", eligible_for_checkout=False,
                candidate_guard_allowed=False,
            ))
        sync_ledger_to_session(s, ledger)
        items, audit = audit_payment_scope(
            s, {"payment_scope": "both"}, "Send both books payment link.",
        )
        assert audit.checkout_count == 2
        assert len(items) == 2

    def test_okay_alone_not_confirm_all(self):
        s = _session()
        from app.cart.ledger import CartItem
        ledger = get_ledger(s)
        ledger._items.append(CartItem(
            title="Blocked", variant_id="gid://b",
            confirmation_status="candidate", candidate_guard_allowed=False,
        ))
        sync_ledger_to_session(s, ledger)
        r = detect("Okay.", s)
        assert r.intent != "add_to_cart" or r.entities.get("confirm_all") != "true"
