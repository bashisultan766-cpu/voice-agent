"""
v4.1 tests — email normalizer, confirmation state machine, PaymentEmailWorker security.
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")


# ── normalize_spoken_email ────────────────────────────────────────────────────

class TestNormalizeSpokenEmail:
    def test_spoken_digits(self):
        from app.pipeline.email_capture import normalize_spoken_email
        result = normalize_spoken_email("bashi sultan seven six six at gmail dot com")
        assert result == "bashisultan766@gmail.com"

    def test_spaced_letters(self):
        from app.pipeline.email_capture import normalize_spoken_email
        result = normalize_spoken_email("j o h n at gmail dot com")
        assert result == "john@gmail.com"

    def test_domain_alias(self):
        from app.pipeline.email_capture import normalize_spoken_email
        result = normalize_spoken_email("alice at gmail dot com")
        assert result == "alice@gmail.com"

    def test_dot_in_local(self):
        from app.pipeline.email_capture import normalize_spoken_email
        result = normalize_spoken_email("alice dot jones at outlook dot com")
        assert result == "alice.jones@outlook.com"

    def test_no_at_returns_none(self):
        from app.pipeline.email_capture import normalize_spoken_email
        result = normalize_spoken_email("hello world")
        assert result is None

    def test_typed_email_passthrough(self):
        from app.pipeline.email_capture import normalize_spoken_email
        result = normalize_spoken_email("jessica@sureshotbooks.com")
        assert result == "jessica@sureshotbooks.com"

    def test_filler_stripped(self):
        from app.pipeline.email_capture import normalize_spoken_email
        result = normalize_spoken_email("my email is bob at yahoo dot com")
        assert result == "bob@yahoo.com"

    def test_oh_maps_to_zero(self):
        from app.pipeline.email_capture import normalize_spoken_email
        result = normalize_spoken_email("test oh two at gmail dot com")
        assert result == "test02@gmail.com"


# ── email_confidence ──────────────────────────────────────────────────────────

class TestEmailConfidence:
    def test_typed_email_is_high(self):
        from app.pipeline.email_capture import email_confidence
        assert email_confidence("jessica@gmail.com", "jessica@gmail.com") == "high"

    def test_common_domain_high(self):
        from app.pipeline.email_capture import email_confidence
        c = email_confidence("alice@gmail.com", "alice at gmail dot com")
        assert c == "high"

    def test_short_local_low(self):
        from app.pipeline.email_capture import email_confidence
        c = email_confidence("a@gmail.com", "a at gmail dot com")
        assert c == "low"

    def test_unknown_domain_medium(self):
        from app.pipeline.email_capture import email_confidence
        c = email_confidence("user@customdomain.com", "user at customdomain dot com")
        assert c in ("medium", "low")

    def test_none_email_is_low(self):
        from app.pipeline.email_capture import email_confidence
        assert email_confidence(None, "hello") == "low"


# ── is_email_correction / is_email_confirmation ───────────────────────────────

class TestCorrectionConfirmation:
    def test_correction_no_thats_wrong(self):
        from app.pipeline.email_capture import is_email_correction
        assert is_email_correction("No that's wrong") is True

    def test_correction_change_it_to(self):
        from app.pipeline.email_capture import is_email_correction
        assert is_email_correction("Can you change it to something else?") is True

    def test_no_correction_on_yes(self):
        from app.pipeline.email_capture import is_email_correction
        assert is_email_correction("Yes that's correct") is False

    def test_confirmation_yes(self):
        from app.pipeline.email_capture import is_email_confirmation
        assert is_email_confirmation("yes") is True

    def test_confirmation_thats_right(self):
        from app.pipeline.email_capture import is_email_confirmation
        assert is_email_confirmation("yes that's correct") is True

    def test_no_confirmation_on_no(self):
        from app.pipeline.email_capture import is_email_confirmation
        assert is_email_confirmation("no") is False


# ── EmailCaptureState state machine ──────────────────────────────────────────

class TestEmailCaptureState:
    def test_set_pending_and_confirm(self):
        from app.pipeline.email_capture import EmailCaptureState
        state = EmailCaptureState()
        state.set_pending("alice@example.com", "high")
        assert state.has_pending
        assert not state.has_confirmed
        ok = state.confirm()
        assert ok is True
        assert state.confirmed_email == "alice@example.com"
        assert state.pending_email == ""

    def test_reject_clears_pending(self):
        from app.pipeline.email_capture import EmailCaptureState
        state = EmailCaptureState()
        state.set_pending("wrong@example.com", "medium")
        state.reject()
        assert state.pending_email == ""
        assert state.rejected_count == 1

    def test_confirm_without_pending_returns_false(self):
        from app.pipeline.email_capture import EmailCaptureState
        state = EmailCaptureState()
        assert state.confirm() is False

    def test_safe_email_for_send_only_confirmed(self):
        from app.pipeline.email_capture import EmailCaptureState
        state = EmailCaptureState()
        state.set_pending("pending@example.com", "high")
        assert state.safe_email_for_send() is None
        state.confirm()
        assert state.safe_email_for_send() == "pending@example.com"

    def test_clear_confirmed(self):
        from app.pipeline.email_capture import EmailCaptureState
        state = EmailCaptureState()
        state.set_pending("user@example.com", "high")
        state.confirm()
        state.clear_confirmed()
        assert state.confirmed_email == ""
        assert state.safe_email_for_send() is None


# ── PaymentEmailWorker v4.1 security rules ────────────────────────────────────

def _make_session():
    from app.state.models import SessionState
    return SessionState(
        session_id="test", call_sid="CA123",
        from_number="+15005550006", to_number="+15005550007",
    )

def _make_settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True)


class TestPaymentEmailWorkerV41:
    async def test_refuses_without_confirmed_email(self):
        from app.workers.payment_email_worker import PaymentEmailWorker
        worker = PaymentEmailWorker()
        session = _make_session()
        session.pending_checkout_url = "https://example.com/pay/1"
        # No confirmed_email set
        result = await worker.run(session, {}, _make_settings())
        assert result.success is False
        assert result.error_code == "no_confirmed_email"

    async def test_returns_unconfirmed_error_when_pending(self):
        from app.workers.payment_email_worker import PaymentEmailWorker
        worker = PaymentEmailWorker()
        session = _make_session()
        session.pending_checkout_url = "https://example.com/pay/1"
        session.pending_email = "alice@example.com"
        # Has pending but NOT confirmed
        result = await worker.run(session, {}, _make_settings())
        assert result.success is False
        assert result.error_code == "email_unconfirmed"
        assert "confirm" in result.safe_summary.lower()

    async def test_sends_with_confirmed_email(self):
        from unittest.mock import AsyncMock, patch
        from app.workers.payment_email_worker import PaymentEmailWorker
        worker = PaymentEmailWorker()
        session = _make_session()
        session.confirmed_email = "alice@example.com"
        session.pending_checkout_url = "https://example.com/pay/1"
        mock_send = AsyncMock(return_value={"success": True})
        with patch("app.tools.email_sender.send_payment_link_email", mock_send):
            result = await worker.run(session, {}, _make_settings())
        assert result.success is True
        assert result.source == "resend"
        mock_send.assert_awaited_once()
        # Confirm email arg used was confirmed_email
        assert mock_send.call_args.kwargs.get("email") == "alice@example.com"

    async def test_duplicate_guard_uses_confirmed_email(self):
        from app.workers.payment_email_worker import PaymentEmailWorker
        worker = PaymentEmailWorker()
        session = _make_session()
        session.confirmed_email = "alice@example.com"
        session.pending_checkout_url = "https://example.com/pay/1"
        session.payment_email_sent_to = ["alice@example.com"]
        result = await worker.run(session, {}, _make_settings())
        assert result.success is True
        assert result.data.get("duplicate") is True


# ── Engine email state machine ────────────────────────────────────────────────

class TestEngineEmailState:
    def test_email_provided_sets_pending(self):
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult
        from app.state.models import SessionState
        session = SessionState(
            session_id="s", call_sid="CA1",
            from_number="+1", to_number="+2",
        )
        intent = IntentResult(
            intent="email_provided",
            confidence=0.85,
            entities={"email": "alice@gmail.com"},
        )
        _apply_email_state(session, intent)
        assert session.pending_email == "alice@gmail.com"
        assert session.confirmed_email == ""

    def test_email_correction_clears_pending(self):
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult
        from app.state.models import SessionState
        session = SessionState(
            session_id="s", call_sid="CA1",
            from_number="+1", to_number="+2",
        )
        session.pending_email = "wrong@example.com"
        intent = IntentResult(
            intent="email_correction",
            confidence=0.90,
            entities={},
        )
        _apply_email_state(session, intent)
        assert session.pending_email == ""
        assert session.email_rejected_count == 1

    def test_email_confirmation_promotes_pending(self):
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult
        from app.state.models import SessionState
        session = SessionState(
            session_id="s", call_sid="CA1",
            from_number="+1", to_number="+2",
        )
        session.pending_email = "alice@gmail.com"
        intent = IntentResult(
            intent="email_confirmation",
            confidence=0.93,
            entities={},
        )
        _apply_email_state(session, intent)
        assert session.confirmed_email == "alice@gmail.com"
        assert session.pending_email == ""

    def test_confirmation_without_pending_is_noop(self):
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult
        from app.state.models import SessionState
        session = SessionState(
            session_id="s", call_sid="CA1",
            from_number="+1", to_number="+2",
        )
        intent = IntentResult(
            intent="email_confirmation",
            confidence=0.93,
            entities={},
        )
        _apply_email_state(session, intent)
        assert session.confirmed_email == ""
