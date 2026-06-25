"""
Deterministic payment email state machine (v4.26).

The LLM must never own payment/email state. All capture, confirmation, and
auto-send decisions flow through this module.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_EMAIL_TYPED = re.compile(
    r"\b([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b",
    re.IGNORECASE,
)

EMAIL_VERIFICATION_PROGRESS = "I'm verifying your email now."

from .email_state import (
    _email_hash,
    confirm_payment_email,
    get_canonical_confirmed_email,
    get_pending_payment_email,
    log_payment_flow_diagnostics,
    reject_pending_payment_email,
    set_pending_payment_email,
    sync_payment_email_fields,
    transition_payment_state,
)


@dataclass
class PaymentTurnHint:
    force_reply: Optional[str] = None
    email_captured: bool = False
    email_confirmed: bool = False
    skip_openai: bool = False


def _cart_has_confirmed_items(session: "SessionState") -> bool:
    try:
        from ..cart.session import get_ledger

        return get_ledger(session).confirmed_count() > 0
    except Exception:  # noqa: BLE001
        items = getattr(session, "cart_items", None) or []
        return any(
            int(i.get("quantity", 0) or 0) >= 1 and i.get("variant_id")
            for i in items
        )


def in_payment_flow(session: "SessionState") -> bool:
    pfs = getattr(session, "payment_flow_status", "idle") or "idle"
    if pfs not in ("idle", ""):
        return True
    return _cart_has_confirmed_items(session)


def email_capture_context_active(session: "SessionState", turn_mode: str = "") -> bool:
    if (turn_mode or "").strip().lower() == "email":
        if in_payment_flow(session):
            return True
        if getattr(session, "payment_cart_confirmed", False):
            return True
        if _cart_has_confirmed_items(session):
            return True
        pfs = getattr(session, "payment_flow_status", "idle") or "idle"
        if pfs in ("awaiting_email", "awaiting_email_confirmation", "awaiting_send_confirmation"):
            return True
    if in_payment_flow(session):
        return True
    if getattr(session, "payment_cart_confirmed", False):
        return True
    return _cart_has_confirmed_items(session)


def _email_signal_present(caller_text: str, turn_mode: str = "") -> bool:
    text = (caller_text or "").strip()
    if not text:
        return False
    if (turn_mode or "").strip().lower() == "email":
        return True
    return bool(extract_email_from_text(text))


def extract_email_from_text(
    text: str,
    session: Optional["SessionState"] = None,
) -> Optional[str]:
    if not text:
        return None
    typed = _EMAIL_TYPED.search(text)
    if typed:
        return typed.group(1).lower().strip()
    try:
        from ..pipeline.email_capture import (
            assemble_email_from_fragments,
            is_domain_suffix_only,
            normalize_spoken_email,
            parse_hyphen_spelled_email,
        )

        spelled = parse_hyphen_spelled_email(text)
        if spelled:
            return spelled

        normalized = normalize_spoken_email(text)
        if normalized:
            return normalized

        if session is not None:
            fragments = list(getattr(session, "pending_email_fragments", None) or [])
            if text.strip():
                if is_domain_suffix_only(text) and fragments:
                    assembled = assemble_email_from_fragments(fragments + [text])
                    if assembled:
                        return assembled
                assembled = assemble_email_from_fragments(fragments + [text])
                if assembled:
                    return assembled
                if fragments:
                    assembled = assemble_email_from_fragments(fragments)
                    if assembled:
                        return assembled
    except Exception:  # noqa: BLE001
        return None
    return None


def speak_confirmation_prompt(email: str) -> str:
    """Full unmasked confirmation — privacy exception for payment email."""
    from ..pipeline.email_speller import speak_email, spell_email_for_voice

    spoken = speak_email(email)
    spelled = spell_email_for_voice(email)
    return (
        f"Just to confirm, I heard {spoken}. "
        f"That is {spelled}. Is that correct?"
    )


def confirmation_prompt(email: str, *, include_spelling: bool = True) -> str:
    if include_spelling:
        return speak_confirmation_prompt(email)
    from ..pipeline.email_speller import speak_email
    return f"Just to confirm, I heard {speak_email(email)}. Is that correct?"


def repeat_email_prompt(email: str) -> str:
    return speak_confirmation_prompt(email)


def begin_awaiting_payment_email(session: "SessionState") -> None:
    """Cart is ready — ask for email deterministically."""
    session.awaiting_payment_email = True
    session.payment_flow_status = "awaiting_email"
    transition_payment_state(session, "idle", "awaiting_email")


def capture_payment_email(session: "SessionState", email: str, *, raw_text: str = "") -> PaymentTurnHint:
    """Set pending email and return deterministic confirmation (no OpenAI)."""
    from ..payment.payment_destination_groups import save_session_email_to_active_group

    normalized = (email or "").strip().lower()
    if not normalized or "@" not in normalized:
        return PaymentTurnHint()

    prior = getattr(session, "payment_flow_status", "idle") or "idle"
    from_state = prior if prior != "idle" else "awaiting_email"
    set_pending_payment_email(session, normalized)
    session.awaiting_payment_email = False
    save_session_email_to_active_group(session)

    sid = (session.call_sid or "")[:6]
    logger.info(
        "payment_email_captured sid=%s pending_email_present=true email_hash=%s",
        sid,
        _email_hash(normalized),
    )
    transition_payment_state(session, from_state, "awaiting_email_confirmation")

    prompt = speak_confirmation_prompt(normalized)
    logger.info(
        "payment_email_confirmation_prompt sid=%s full_email_spoken=true "
        "spelled=true openai_skipped=true",
        sid,
    )
    return PaymentTurnHint(
        email_captured=True,
        force_reply=f"{EMAIL_VERIFICATION_PROGRESS} {prompt}",
        skip_openai=True,
    )


def confirm_pending_payment_email(session: "SessionState") -> PaymentTurnHint:
    """Promote pending → confirmed_email and trigger auto-send."""
    from ..payment.payment_destination_groups import save_session_email_to_active_group

    pending = get_pending_payment_email(session)
    if not confirm_payment_email(session):
        logger.warning(
            "payment_email_confirm_failed sid=%s pending_offer_present=%s",
            (session.call_sid or "")[:6],
            bool(pending),
        )
        return PaymentTurnHint()

    confirmed = get_canonical_confirmed_email(session)
    if not confirmed or not session.payment_email_confirmed:
        return PaymentTurnHint()

    save_session_email_to_active_group(session)
    sid = (session.call_sid or "")[:6]
    logger.info(
        "payment_email_confirmed sid=%s confirmed_email_present=true "
        "payment_email_confirmed=true",
        sid,
    )
    log_payment_flow_diagnostics(session, stage="email_confirmed")
    return PaymentTurnHint(email_confirmed=True, skip_openai=True)


def _looks_like_partial_email(text: str) -> bool:
    """True when caller is likely mid-email (at/dot/domain fragment)."""
    t = (text or "").lower()
    if not t:
        return False
    markers = (" at ", " dot ", "@", "gmail", "yahoo", "outlook", "hotmail", "icloud", " activate ")
    return any(m in f" {t} " for m in markers)


def needs_deferred_payment_auto_send(session: "SessionState") -> bool:
    """
    True when email was confirmed on a prior turn but payment link was never sent.
    Catches LLM-path confirmations that skipped auto-send.
    """
    if getattr(session, "payment_link_sent", False):
        return False
    if getattr(session, "awaiting_payment_email_confirmation", False):
        return False
    if not getattr(session, "payment_email_confirmed", False):
        return False
    confirmed = get_canonical_confirmed_email(session)
    if not confirmed:
        return False
    pfs = getattr(session, "payment_flow_status", "idle") or "idle"
    return pfs == "awaiting_send_confirmation"


def _try_confirm_email_turn(
    session: "SessionState",
    text: str,
) -> PaymentTurnHint:
    """Confirm pending/last-offered email on yes/correct — highest priority."""
    from ..pipeline.email_capture import is_email_confirmation
    from ..agent_runtime.yes_engagement import is_bare_yes

    awaiting = bool(getattr(session, "awaiting_payment_email_confirmation", False))
    pending = get_pending_payment_email(session)
    if not awaiting and not pending:
        return PaymentTurnHint()

    if not (is_email_confirmation(text) or is_bare_yes(text)):
        return PaymentTurnHint()

    hint = confirm_pending_payment_email(session)
    if hint.email_confirmed:
        from ..payment.payment_destination_groups import save_session_email_to_active_group

        save_session_email_to_active_group(session)
    return hint


def process_payment_turn(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> PaymentTurnHint:
    """
    Update payment session state from caller text before the LLM runs.

    Returns a hint with ``force_reply`` when the runtime should speak a
    deterministic confirmation prompt instead of letting the LLM send payment.
    """
    from ..pipeline.email_capture import (
        is_email_confirmation,
        is_email_correction,
        is_email_spell_request,
        is_repeat_email_request,
        parse_hyphen_spelled_email,
    )

    sync_payment_email_fields(session)
    session.payment_cart_confirmed = _cart_has_confirmed_items(session)

    text = (caller_text or "").strip()
    if not text:
        return PaymentTurnHint()

    confirm_hint = _try_confirm_email_turn(session, text)
    if confirm_hint.email_confirmed or confirm_hint.force_reply:
        return confirm_hint

    from ..payment.payment_destination_groups import (
        ensure_payment_groups,
        save_session_email_to_active_group,
        sync_active_group_to_session_email,
        try_parse_multi_email_assignment,
    )

    if _cart_has_confirmed_items(session):
        ensure_payment_groups(session)
        if try_parse_multi_email_assignment(text, session):
            sync_active_group_to_session_email(session)
            groups = session.payment_destination_groups
            if len(groups) >= 2 and groups[0].get("pending_email"):
                return capture_payment_email(session, groups[0]["pending_email"], raw_text=text)

    sync_active_group_to_session_email(session)
    email_signal = _email_signal_present(text, turn_mode)
    if not email_capture_context_active(session, turn_mode):
        if email_signal:
            sid = (session.call_sid or "")[:6]
            logger.warning(
                "email_capture_skipped sid=%s turn_mode=%s reason=no_payment_context "
                "cart_confirmed=%s payment_flow_status=%s",
                sid,
                turn_mode or "normal",
                _cart_has_confirmed_items(session),
                getattr(session, "payment_flow_status", "idle"),
            )
        return PaymentTurnHint()

    if is_email_spell_request(text):
        pending = get_pending_payment_email(session) or get_canonical_confirmed_email(session)
        if pending:
            log_payment_flow_diagnostics(session, stage="email_spell_request")
            return PaymentTurnHint(force_reply=repeat_email_prompt(pending), skip_openai=True)

    if is_email_correction(text):
        reject_pending_payment_email(session)
        email = extract_email_from_text(text, session) or parse_hyphen_spelled_email(text)
        if email:
            return capture_payment_email(session, email, raw_text=text)
        return PaymentTurnHint()

    pending_offer = get_pending_payment_email(session)

    if is_repeat_email_request(text) and pending_offer:
        session.pending_payment_email = pending_offer
        session.pending_email = pending_offer
        session.awaiting_payment_email_confirmation = True
        session.payment_flow_status = "awaiting_email_confirmation"
        log_payment_flow_diagnostics(session, stage="email_repeat")
        return PaymentTurnHint(force_reply=repeat_email_prompt(pending_offer), skip_openai=True)

    email = extract_email_from_text(text, session)
    if email:
        hint = capture_payment_email(session, email, raw_text=text)
        save_session_email_to_active_group(session)
        if hasattr(session, "pending_email_fragments"):
            session.pending_email_fragments = []
        return hint

    if email_signal and _looks_like_partial_email(text):
        fragments = getattr(session, "pending_email_fragments", None)
        if fragments is not None:
            if text not in fragments:
                session.pending_email_fragments = [*fragments, text]
            logger.info(
                "payment_email_fragment_stored sid=%s count=%d",
                (session.call_sid or "")[:6],
                len(session.pending_email_fragments),
            )
            return PaymentTurnHint(
                force_reply=(
                    "Got it — please continue with the rest of your email address, "
                    "or say the full email again."
                ),
                skip_openai=True,
            )

    from ..agent_runtime.yes_engagement import is_bare_yes, yes_engagement_reply

    if is_bare_yes(text) and getattr(session, "awaiting_payment_email", False):
        reply = yes_engagement_reply(session)
        if reply:
            return PaymentTurnHint(force_reply=reply, skip_openai=True)

    return PaymentTurnHint()
