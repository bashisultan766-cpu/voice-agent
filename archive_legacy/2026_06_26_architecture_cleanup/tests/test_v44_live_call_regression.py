"""
v4.4 live-call regression tests (utterances from production logs).
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.pipeline.compound_intent import detect
from app.pipeline.engine import _apply_email_state
from app.pipeline.router import IntentResult
from app.state.models import SessionState
from app.workers.orchestrator import WorkerOrchestrator


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="live", call_sid="CA_LIVE01",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


def _settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True, VOICE_FILLER_AFTER_MS=0)


class TestLiveCallRegression:
    def test_01_vague_book(self):
        assert detect("I need a book.").intent == "vague_book_request"

    def test_02_have_isbn(self):
        assert detect("Yeah. I have the ISBN number.").intent == "isbn_collection_start"

    def test_03_isbn_digits(self):
        r = detect("9 7 8 1 5 1 7 2 0 9 7 5 9.")
        assert r.intent == "isbn_search"

    def test_06_compound_payment_four_books(self):
        r = detect(
            "No. I gave you 4 ISBN of 4 books. "
            "You send me the 4 books payment link on my email."
        )
        assert r.intent == "send_payment_link"
        assert r.entities.get("requested_cart_count") == "4"

    def test_07_email_provided(self):
        r = detect("My email is ashisultan766@gmail.com.")
        assert r.intent == "email_provided"
        assert r.entities.get("email")

    def test_08_email_correction(self):
        assert detect("No. It's not correct.").intent == "email_correction"

    def test_09_email_retry(self):
        r = detect("Bashisultan766@gmail.com.")
        assert r.entities.get("email")

    def test_10_spell_this(self):
        s = _session()
        s.pending_email = "bashisultan766@gmail.com"
        s.payment_flow_status = "awaiting_email_confirmation"
        assert detect("Can you spell this?", s).intent == "spell_email_request"

    def test_11_email_confirm(self):
        s = _session()
        s.pending_email = "bashisultan766@gmail.com"
        s.payment_flow_status = "awaiting_email_confirmation"
        ir = IntentResult(intent="email_confirmation", confidence=0.95, entities={})
        _apply_email_state(s, ir)
        assert s.confirmed_email == "bashisultan766@gmail.com"
        assert s.payment_flow_status == "awaiting_send_confirmation"

    def test_12_send_payment_link_intent(self):
        s = _session(confirmed_email="bashisultan766@gmail.com",
                     payment_flow_status="awaiting_send_confirmation")
        s.cart_items = [{
            "title": "Book", "variant_id": "gid://1", "quantity": 1,
            "confirmation_status": "confirmed",
        }]
        assert detect("Send me the payment link.", s).intent == "send_payment_link"

    def test_13_did_you_send(self):
        assert detect("Did you send this?").intent == "payment_status_question"

    def test_14_compound_payment_email(self):
        r = detect("Send payment link on BashiSultan766@gmail.com.")
        assert r.intent == "send_payment_link"
        assert r.entities.get("email")

    async def test_payment_turn_runs_payment_flow_worker(self):
        orch = WorkerOrchestrator()
        s = _session()
        s.cart_items = [{
            "title": "Book", "variant_id": "gid://1", "quantity": 1,
            "confirmation_status": "confirmed",
        }]
        ir = IntentResult(
            intent="send_payment_link", confidence=0.9,
            entities={"intent": "send_payment_link"},
        )
        bundle = await orch.run(ir, s, _settings())
        assert "payment_flow" in bundle.results
        pf = bundle.results["payment_flow"]
        assert pf.data.get("ran") is True
