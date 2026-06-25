"""
v4.3 tests — DialogueManager and router intelligence.
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.dialogue.manager import DialogueManager, spell_email_letter_by_letter
from app.dialogue.states import DialogueState
from app.pipeline.email_speller import spell_email_for_voice
from app.pipeline.router import detect
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="s-v43", call_sid="CA_V43001",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


class TestVagueBookRequest:
    def test_i_need_a_book(self):
        r = detect("I need a book.")
        assert r.intent == "vague_book_request"
        assert "isbn" not in r.entities

    def test_i_want_a_book(self):
        r = detect("I want a book")
        assert r.intent == "vague_book_request"

    def test_book_by_isbn_starts_collection(self):
        r = detect("I need a book by ISBN")
        assert r.intent == "isbn_collection_start"

    def test_book_with_title_searches(self):
        r = detect("I need a book called Game of Thrones")
        assert r.intent == "book_title_search"
        assert r.entities.get("product_phrase")

    def test_books_about_history_searches(self):
        r = detect("I need books about history")
        assert r.intent in ("product_search", "book_title_search", "multi_book_order")


class TestSpellEmailIntent:
    def test_spell_my_email(self):
        r = detect("Can you spell my email?")
        assert r.intent == "spell_email_request"

    def test_letter_by_letter(self):
        r = detect("Can you spell it letter by letter?")
        assert r.intent == "spell_email_request"

    def test_what_email_do_you_have(self):
        r = detect("What email do you have?")
        assert r.intent == "spell_email_request"

    def test_spell_not_author_search(self):
        r = detect("Can you spell my email letter by letter?")
        assert r.intent != "author_search"


class TestCartMemoryIntents:
    def test_how_many_isbn(self):
        r = detect("How many ISBN numbers did I give you?")
        assert r.intent == "isbn_count_question"

    def test_titles_one_by_one(self):
        r = detect("Tell me the titles one by one.")
        assert r.intent == "titles_question"


class TestDialogueManager:
    def test_vague_book_clarification(self):
        from app.pipeline.router import IntentResult
        session = _session()
        ir = IntentResult(intent="vague_book_request", confidence=0.9, entities={})
        d = DialogueManager.process_turn(session, ir, "I need a book")
        assert d.should_clarify
        assert "ISBN" in d.clarification_prompt

    def test_spell_email_response_confirmed(self):
        session = _session(confirmed_email="alice@example.com")
        text = DialogueManager.build_spell_email_response(session)
        assert "alice" in text.lower() or "a" in text
        assert spell_email_for_voice("alice@example.com") in text

    def test_spell_email_no_email(self):
        session = _session()
        text = DialogueManager.build_spell_email_response(session)
        assert "do not have" in text.lower() or "don't have" in text.lower()

    def test_spell_letters_helper(self):
        spelled = spell_email_letter_by_letter("ab@x.com")
        assert "a" in spelled and "at" in spelled

    def test_yes_outside_email_does_not_force_email_confirm(self):
        session = _session()
        r = detect("yes", session)
        assert r.intent == "confirmation"
        assert r.intent != "email_confirmation"

    def test_yes_during_email_confirmation(self):
        session = _session(
            pending_email="alice@example.com",
            payment_flow_status="awaiting_email_confirmation",
        )
        r = detect("yes", session)
        assert r.intent == "email_confirmation"

    def test_payment_execute_on_final_yes(self):
        session = _session(
            confirmed_email="alice@example.com",
            payment_flow_status="awaiting_send_confirmation",
        )
        r = detect("yes", session)
        assert r.intent == "payment_execute"


class TestDialogueStateTransitions:
    def test_another_book_flow(self):
        from app.pipeline.router import IntentResult
        session = _session()
        ir = IntentResult(intent="another_book", confidence=0.9, entities={})
        d = DialogueManager.process_turn(session, ir, "another book")
        assert d.should_clarify
        assert session.dialogue.active_flow == "isbn_collection"
