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
    if _looks_like_partial_email(text):
        return True
    return bool(extract_email_from_text(text))


def extract_email_from_text(
    text: str,
    session: Optional["SessionState"] = None,
) -> Optional[str]:
    from ..email.resolver import resolve_spoken_email_address

    resolved = resolve_spoken_email_address(text, session=session)
    return resolved.email or None


def speak_confirmation_prompt(email: str) -> str:
    """Full unmasked confirmation — spoken email plus letter-by-letter readback."""
    from ..email.speller import speak_email, spell_email_letter_by_letter

    spoken = speak_email(email)
    spelled = spell_email_letter_by_letter(email)
    return (
        f"Just to confirm, I heard {spoken}. "
        f"Slowly, letter by letter, that is {spelled}. Is that correct?"
    )


def confirmation_prompt(email: str, *, include_spelling: bool = True) -> str:
    if include_spelling:
        return speak_confirmation_prompt(email)
    from ..email.speller import speak_email
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
    from ..email.capture import is_email_confirmation
    from ..agent_runtime.yes_engagement import is_bare_yes

    sync_llm_offered_email_from_history(session)

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


_CONFIRM_MARKERS = re.compile(
    r"\b(just to confirm|i heard|is that correct|that is)\b",
    re.I,
)

_EMAIL_FRUSTRATION = re.compile(
    r"\b(?:told you|said (?:it|my email)|already (?:gave|said|told)|"
    r"(?:five|5)\s+times?|not opened|asking for a spelling)\b",
    re.I,
)


def support_email_turn_priority(session: "SessionState", turn_mode: str = "") -> bool:
    """Support handoff email capture — independent from payment email."""
    return bool(getattr(session, "awaiting_not_found_escalation_email", False))


def payment_email_turn_priority(session: "SessionState", turn_mode: str = "") -> bool:
    """True when payment email capture should run before order/LLM paths."""
    if support_email_turn_priority(session, turn_mode):
        return False
    if (turn_mode or "").strip().lower() == "email":
        return True
    if getattr(session, "awaiting_payment_email", False):
        return True
    if getattr(session, "awaiting_payment_email_confirmation", False):
        return True
    pfs = getattr(session, "payment_flow_status", "idle") or "idle"
    return pfs in ("awaiting_email", "awaiting_email_confirmation", "awaiting_send_confirmation")


def sync_llm_offered_email_from_history(session: "SessionState") -> bool:
    """
    When the LLM read back an email for confirmation, track it as pending so
    a later yes/correct can promote it to confirmed_email.
    """
    if getattr(session, "payment_email_confirmed", False):
        return False
    if not (in_payment_flow(session) or _cart_has_confirmed_items(session)):
        items = getattr(session, "cart_items", None) or []
        if not any(int(i.get("quantity", 0) or 0) >= 1 for i in items):
            pfs = getattr(session, "payment_flow_status", "idle") or "idle"
            if pfs not in (
                "awaiting_email",
                "awaiting_email_confirmation",
                "awaiting_send_confirmation",
            ):
                return False

    from ..email.capture import normalize_spoken_email

    history = list(getattr(session, "history", None) or [])
    for msg in reversed(history):
        if (msg.get("role") or "") != "assistant":
            continue
        content = (msg.get("content") or "").strip()
        if not content or not _CONFIRM_MARKERS.search(content):
            break

        quoted = re.search(r'["\']([^"\']+at[^"\']+)["\']', content, re.I)
        candidate_text = (quoted.group(1) if quoted else content).strip().rstrip('."\'')
        email = normalize_spoken_email(candidate_text)
        if not email:
            typed = re.search(
                r"\b([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b",
                candidate_text,
            )
            email = typed.group(1).lower().strip() if typed else None
        if not email or "@" not in email:
            break

        normalized = email.strip().lower()
        existing = get_pending_payment_email(session)
        if existing != normalized:
            set_pending_payment_email(session, normalized)
        else:
            session.awaiting_payment_email_confirmation = True
            session.payment_flow_status = "awaiting_email_confirmation"
        return True
    return False


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
    from ..email.capture import (
        is_email_confirmation,
        is_email_correction,
        is_email_spell_request,
        is_repeat_email_request,
        parse_hyphen_spelled_email,
    )

    sync_payment_email_fields(session)
    session.payment_cart_confirmed = _cart_has_confirmed_items(session)

    from ..email.capture import extract_best_email_phrase

    text = (caller_text or "").strip()
    capture_text = extract_best_email_phrase(text) or text
    if not text:
        return PaymentTurnHint()

    if _cart_has_confirmed_items(session):
        sync_llm_offered_email_from_history(session)

    confirm_hint = _try_confirm_email_turn(session, capture_text)
    if confirm_hint.email_confirmed or confirm_hint.force_reply:
        return confirm_hint

    from ..agent_runtime.isbn_short_circuit import payment_email_context_active

    email_payment_ctx = payment_email_context_active(session, turn_mode)
    if email_payment_ctx:
        session.pending_isbn_buffer = ""

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

    if is_email_spell_request(text) or is_repeat_email_request(text):
        pending = get_pending_payment_email(session) or get_canonical_confirmed_email(session)
        if pending:
            log_payment_flow_diagnostics(session, stage="email_spell_request")
            return PaymentTurnHint(force_reply=repeat_email_prompt(pending), skip_openai=True)

    email_ctx = email_capture_context_active(session, turn_mode) or email_payment_ctx
    awaiting_email_confirm = bool(getattr(session, "awaiting_payment_email_confirmation", False))

    if is_email_correction(text) and (email_ctx or awaiting_email_confirm):
        reject_pending_payment_email(session)
        session.pending_isbn_buffer = ""
        email = (
            extract_email_from_text(capture_text, session)
            or parse_hyphen_spelled_email(capture_text)
        )
        if email:
            return capture_payment_email(session, email, raw_text=text)
        return PaymentTurnHint(
            force_reply="No problem — please tell me the correct email address.",
            skip_openai=True,
        )

    email_signal = _email_signal_present(text, turn_mode) or _email_signal_present(capture_text, turn_mode)
    if not email_ctx:
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

    awaiting_confirm = bool(getattr(session, "awaiting_payment_email_confirmation", False))
    awaiting_email = bool(getattr(session, "awaiting_payment_email", False))

    if (
        email_ctx
        and (
            is_email_spell_request(text)
            or is_repeat_email_request(text)
            or _EMAIL_FRUSTRATION.search(text)
            or (awaiting_confirm and re.search(r"\bemail\b", text, re.I))
        )
    ):
        pending = get_pending_payment_email(session) or get_canonical_confirmed_email(session)
        if pending:
            log_payment_flow_diagnostics(session, stage="email_frustration_repeat")
            return PaymentTurnHint(force_reply=repeat_email_prompt(pending), skip_openai=True)

    if awaiting_confirm and email_signal and not is_email_confirmation(text):
        replacement = (
            extract_email_from_text(capture_text, session)
            or parse_hyphen_spelled_email(capture_text)
        )
        if replacement:
            reject_pending_payment_email(session)
            if hasattr(session, "pending_email_fragments"):
                session.pending_email_fragments = []
            return capture_payment_email(session, replacement, raw_text=text)

    pending_offer = get_pending_payment_email(session)

    if is_repeat_email_request(text) and pending_offer:
        session.pending_payment_email = pending_offer
        session.pending_email = pending_offer
        session.awaiting_payment_email_confirmation = True
        session.payment_flow_status = "awaiting_email_confirmation"
        log_payment_flow_diagnostics(session, stage="email_repeat")
        return PaymentTurnHint(force_reply=repeat_email_prompt(pending_offer), skip_openai=True)

    email = extract_email_from_text(capture_text, session)
    if email:
        hint = capture_payment_email(session, email, raw_text=text)
        save_session_email_to_active_group(session)
        if hasattr(session, "pending_email_fragments"):
            session.pending_email_fragments = []
        return hint

    if email_signal and _looks_like_partial_email(text):
        fragments = getattr(session, "pending_email_fragments", None)
        if fragments is not None:
            from ..email.resolver import fragment_capture_prompt, resolve_spoken_email_address

            solo = resolve_spoken_email_address(capture_text, session=None)
            if solo.email:
                if hasattr(session, "pending_email_fragments"):
                    session.pending_email_fragments = []
                return capture_payment_email(session, solo.email, raw_text=text)
            combined = " ".join([*fragments, capture_text]).strip()
            merged = resolve_spoken_email_address(combined, session=None)
            if merged.email:
                if hasattr(session, "pending_email_fragments"):
                    session.pending_email_fragments = []
                return capture_payment_email(session, merged.email, raw_text=text)
            if capture_text not in fragments:
                session.pending_email_fragments = [*fragments, capture_text]
            count = len(session.pending_email_fragments)
            logger.info(
                "payment_email_fragment_stored sid=%s count=%d",
                (session.call_sid or "")[:6],
                count,
            )
            return PaymentTurnHint(
                force_reply=fragment_capture_prompt(count),
                skip_openai=True,
            )

    from ..agent_runtime.yes_engagement import is_bare_yes, yes_engagement_reply

    if is_bare_yes(text) and getattr(session, "awaiting_payment_email", False):
        reply = yes_engagement_reply(session)
        if reply:
            return PaymentTurnHint(force_reply=reply, skip_openai=True)

    return PaymentTurnHint()
