"""
Voice email capture — spoken email normalization and confirmation.

Wraps email/capture.py and email/speller.py for the commerce runtime.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional

from ..email.capture import (
    is_email_confirmation,
    is_email_correction,
    normalize_spoken_email,
    parse_hyphen_spelled_email,
)
from ..email.speller import build_email_readback, speak_email, spell_email_for_voice
from ..payment.email_state import (
    confirm_payment_email,
    get_canonical_confirmed_email,
    get_pending_payment_email,
    reject_pending_payment_email,
    set_pending_payment_email,
    sync_payment_email_fields,
)
from ..payment.payment_state_machine import extract_email_from_text

if TYPE_CHECKING:
    from ..state.models import SessionState


@dataclass
class EmailCaptureResult:
    email: str = ""
    confirmed: bool = False
    rejected: bool = False
    readback: str = ""
    needs_confirmation: bool = False
    action: str = "none"  # captured | confirmed | rejected | correction | none


class VoiceEmailCapture:
    """Strong email capture with spell-back confirmation for voice calls."""

    def __init__(self, session: "SessionState") -> None:
        self._session = session

    @property
    def confirmed_email(self) -> str:
        sync_payment_email_fields(self._session)
        return get_canonical_confirmed_email(self._session)

    @property
    def pending_email(self) -> str:
        return get_pending_payment_email(self._session)

    @property
    def is_verified(self) -> bool:
        return bool(getattr(self._session, "payment_email_confirmed", False))

    def capture_from_speech(self, text: str) -> EmailCaptureResult:
        """Normalize spoken email and stage for confirmation."""
        email = extract_email_from_text(text, self._session)
        if not email:
            email = normalize_spoken_email(text) or parse_hyphen_spelled_email(text)
        if not email:
            return EmailCaptureResult(action="none")

        set_pending_payment_email(self._session, email)
        self._session.awaiting_payment_email_confirmation = True
        self._session.payment_flow_status = "awaiting_email_confirmation"
        readback = build_email_readback(email, raw_text=text)
        return EmailCaptureResult(
            email=email,
            readback=readback,
            needs_confirmation=True,
            action="captured",
        )

    def process_confirmation_turn(self, text: str) -> EmailCaptureResult:
        """Handle yes/no on pending email confirmation."""
        sync_payment_email_fields(self._session)
        pending = get_pending_payment_email(self._session)

        if is_email_correction(text):
            reject_pending_payment_email(self._session)
            self._session.awaiting_payment_email_confirmation = False
            return EmailCaptureResult(
                rejected=True,
                readback="No problem. Please spell your email address slowly.",
                action="correction",
            )

        if is_email_confirmation(text) and pending:
            confirm_payment_email(self._session)
            self._session.awaiting_payment_email_confirmation = False
            self._session.payment_email_confirmed = True
            self._session.payment_flow_status = "email_confirmed"
            return EmailCaptureResult(
                email=pending,
                confirmed=True,
                action="confirmed",
            )

        if text.strip().lower().startswith("no") and pending:
            reject_pending_payment_email(self._session)
            self._session.awaiting_payment_email_confirmation = False
            return EmailCaptureResult(
                rejected=True,
                readback="Okay, let's try again. What is your email address?",
                action="rejected",
            )

        new_capture = self.capture_from_speech(text)
        if new_capture.email:
            return new_capture

        return EmailCaptureResult(action="none")

    def spell_back(self, email: Optional[str] = None) -> str:
        """Build spell-back confirmation prompt."""
        addr = email or self.pending_email or self.confirmed_email
        if not addr:
            return "What email should I send the payment link to?"
        spoken = speak_email(addr)
        spelled = spell_email_for_voice(addr)
        return f"I heard {spoken}. That's {spelled}. Is that correct?"
