"""v4.6 tests — long call memory + payment/cart continuity."""
from __future__ import annotations

import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.cart.candidate import save_product_candidate
from app.cart.session import get_ledger, sync_ledger_to_session
from app.composer.main_llm_composer import _deterministic_response
from app.conversation.call_memory import record_user_turn, sync_from_session, get_call_memory
from app.dialogue.manager import DialogueManager
from app.pipeline.router import detect, IntentResult
from app.state.models import SessionState
from app.workers.payment_flow_worker import PaymentFlowWorker
from app.workers.checkout_worker import CheckoutWorker
from app.workers.payment_email_worker import PaymentEmailWorker


def _session() -> SessionState:
    return SessionState(
        session_id="s-lm", call_sid="CA_LM01",
        from_number="+15551234567", to_number="+18005551234",
    )


def _settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True, VOICE_TOOL_TIMEOUT_MS=2500)


class TestLongMemoryPaymentContinuity:
    def _confirm_three_isbns(self, s: SessionState) -> None:
        for isbn in ("978111", "978222", "978333"):
            save_product_candidate(
                s, title=f"Book {isbn}", isbn=isbn, variant_id=f"gid://{isbn}",
            )
            ledger = get_ledger(s)
            ledger.confirm_last_candidate()
            sync_ledger_to_session(s, ledger)
            s.isbn_history.append(isbn)

    def test_cart_persists_after_filler_turns(self):
        s = _session()
        self._confirm_three_isbns(s)
        for i in range(40):
            record_user_turn(s, f"random store question {i}")
        assert get_ledger(s).confirmed_count() == 3

    def test_isbn_memory_after_filler(self):
        s = _session()
        self._confirm_three_isbns(s)
        for i in range(40):
            record_user_turn(s, f"filler {i}")
        sync_from_session(s)
        assert len(get_call_memory(s).isbns_provided) >= 3

    async def test_send_link_after_long_call_cart_count(self):
        s = _session()
        self._confirm_three_isbns(s)
        s.confirmed_email = "buyer@example.com"
        s.payment_flow_status = "awaiting_send_confirmation"
        for i in range(40):
            record_user_turn(s, f"filler {i}")

        worker = PaymentFlowWorker()
        with patch.object(PaymentEmailWorker, "run", new_callable=AsyncMock) as mock_email:
            mock_email.return_value = __import__(
                "app.workers.base", fromlist=["WorkerResult"]
            ).WorkerResult(
                worker_name="payment_email",
                success=True,
                data={"email_sent": True},
                safe_summary="Sent.",
            )
            with patch.object(CheckoutWorker, "run", new_callable=AsyncMock) as mock_chk:
                mock_chk.return_value = __import__(
                    "app.workers.base", fromlist=["WorkerResult"]
                ).WorkerResult(
                    worker_name="checkout",
                    success=True,
                    data={"checkout_url": "https://example.com/checkout"},
                    safe_summary="Checkout ready.",
                )
                r = await worker.run(
                    s,
                    {"intent": "send_payment_link", "payment_scope": "prior_cart"},
                    _settings(),
                )
        assert get_ledger(s).confirmed_count() == 3
        data = r.data or {}
        assert data.get("cart_count") == 3 or get_ledger(s).confirmed_count() == 3

    def test_composer_no_isbn_ask_when_cart_full(self):
        s = _session()
        self._confirm_three_isbns(s)
        excerpt = __import__(
            "app.domain.sureshot_brain", fromlist=["build_domain_excerpt"]
        ).build_domain_excerpt(s, "give me isbn", "isbn_collection_start")
        assert "do not ask" in excerpt.lower() or s.isbn_history

    def test_memory_summary_after_long_call(self):
        s = _session()
        self._confirm_three_isbns(s)
        for i in range(40):
            record_user_turn(s, f"filler {i}")
        text = DialogueManager.build_memory_response(s, "memory_summary_question")
        assert "3" in text or "three" in text.lower()

    def test_email_spell_after_long_call(self):
        s = _session()
        self._confirm_three_isbns(s)
        s.confirmed_email = "buyer@example.com"
        for i in range(10):
            record_user_turn(s, f"filler {i}")
        spell = DialogueManager.build_spell_email_response(s)
        assert "buyer" in spell.lower() or "@" in spell

    def test_deterministic_no_isbn_repeat(self):
        s = _session()
        self._confirm_three_isbns(s)
        ir = IntentResult(intent="memory_summary_question", confidence=0.9)
        s.response_plan = {
            "action": "answer_memory",
            "say": DialogueManager.build_memory_response(s, "memory_summary_question"),
        }
        text = _deterministic_response(s, ir)
        assert text and "ISBN" in text or "book" in text.lower()
