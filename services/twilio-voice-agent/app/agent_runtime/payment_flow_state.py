"""
Payment flow state machine for the LLM-first runtime (v4.19).

Enforces: cart confirmed → email captured → email read back → explicit yes →
send_payment_link. Never sends before confirmation. Never claims success on failure.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_EMAIL_TYPED = re.compile(
    r"\b([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b",
    re.IGNORECASE,
)

PAYMENT_SUCCESS_MESSAGE = (
    "I sent the secure payment link to your email. "
    "Please check your inbox and spam folder."
)
PAYMENT_FAILURE_MESSAGE = (
    "I'm sorry, I could not send the payment link right now. "
    "I can try again or forward this to customer service."
)

_DIRECT_LINK_PHRASE = re.compile(
    r"\b(use|using|provide|giving|give)\s+(you\s+)?(the\s+)?(direct\s+)?(url|link)\b"
    r"|\bdirect\s+(url|link)\b",
    re.I,
)
_FALSE_SUCCESS_PAT = re.compile(
    r"\b("
    r"sent|created|emailed|payment link|checkout link|"
    r"direct url|provided url|use the url|link from our conversation"
    r")\b",
    re.I,
)


def scrub_false_payment_claims(text: str) -> str:
    """Remove premature checkout/order claims and forbidden direct-link phrasing."""
    if not text:
        return text
    if _DIRECT_LINK_PHRASE.search(text):
        return PAYMENT_FAILURE_MESSAGE
    if re.search(r"\border\s+(number\s+)?D\d+\b", text, re.I) and _FALSE_SUCCESS_PAT.search(text):
        return PAYMENT_FAILURE_MESSAGE
    return text


@dataclass
class PaymentTurnHint:
    force_reply: Optional[str] = None
    email_captured: bool = False
    email_confirmed: bool = False


@dataclass
class PaymentGateResult:
    allowed: bool
    tool_json: str = ""
    reason: str = ""


from ..payment.email_state import (
    confirm_payment_email,
    get_canonical_confirmed_email,
    get_pending_payment_email,
    log_payment_flow_diagnostics,
    reject_pending_payment_email,
    set_pending_payment_email,
    sync_payment_email_fields,
)


def _sync_legacy_email_fields(session: "SessionState") -> None:
    sync_payment_email_fields(session)


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
    """True when cart/checkout/payment is active enough for deterministic email capture."""
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


def extract_email_from_text(text: str) -> Optional[str]:
    if not text:
        return None
    typed = _EMAIL_TYPED.search(text)
    if typed:
        return typed.group(1).lower().strip()
    try:
        from ..pipeline.email_capture import normalize_spoken_email, parse_hyphen_spelled_email

        spelled = parse_hyphen_spelled_email(text)
        if spelled:
            return spelled
        return normalize_spoken_email(text)
    except Exception:  # noqa: BLE001
        return None


def repeat_email_prompt(email: str) -> str:
    """Deterministic readback when caller asks to repeat the email."""
    from ..pipeline.email_speller import spell_email_for_voice

    spelled = spell_email_for_voice(email)
    return f"{spelled}. {confirmation_prompt(email)}"


def confirmation_prompt(email: str, *, include_spelling: bool = True) -> str:
    """
    Payment email confirmation — FULL email required (never masked).

    Caller must hear the complete address plus spelled readback for voice verification.
    """
    from ..pipeline.email_speller import spell_email_for_voice

    base = f"Just to confirm, I heard {email}."
    if include_spelling:
        spelled = spell_email_for_voice(email)
        if spelled:
            return f"{base} {spelled}. Is that correct?"
    return f"{base} Is that correct?"


def _confirm_payment_email(session: "SessionState") -> None:
    if confirm_payment_email(session):
        log_payment_flow_diagnostics(session, stage="email_confirmed")
        logger.info(
            "payment_email_confirmed sid=%s",
            session.call_sid[:6] if session.call_sid else "?",
        )


def _reject_pending_email(session: "SessionState") -> None:
    reject_pending_payment_email(session)


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
        is_repeat_email_request,
        parse_hyphen_spelled_email,
    )

    _sync_legacy_email_fields(session)
    session.payment_cart_confirmed = _cart_has_confirmed_items(session)

    text = (caller_text or "").strip()
    if not text:
        return PaymentTurnHint()

    email_signal = _email_signal_present(text, turn_mode)
    if not email_capture_context_active(session, turn_mode):
        if email_signal:
            sid = session.call_sid[:6] if session.call_sid else "?"
            logger.warning(
                "email_capture_skipped sid=%s turn_mode=%s reason=no_payment_context "
                "cart_confirmed=%s payment_flow_status=%s",
                sid,
                turn_mode or "normal",
                _cart_has_confirmed_items(session),
                getattr(session, "payment_flow_status", "idle"),
            )
        return PaymentTurnHint()

    from ..pipeline.email_capture import is_email_spell_request

    if is_email_spell_request(text):
        pending = get_pending_payment_email(session) or get_canonical_confirmed_email(session)
        if pending:
            log_payment_flow_diagnostics(session, stage="email_spell_request")
            return PaymentTurnHint(force_reply=repeat_email_prompt(pending))

    if is_email_correction(text):
        _reject_pending_email(session)
        email = extract_email_from_text(text) or parse_hyphen_spelled_email(text)
        if email:
            set_pending_payment_email(session, email)
            log_payment_flow_diagnostics(session, stage="email_pending_correction")
            return PaymentTurnHint(
                email_captured=True,
                force_reply=confirmation_prompt(email),
            )
        return PaymentTurnHint()

    pending_offer = get_pending_payment_email(session)

    if is_repeat_email_request(text) and pending_offer:
        session.pending_payment_email = pending_offer
        session.pending_email = pending_offer
        session.awaiting_payment_email_confirmation = True
        session.payment_flow_status = "awaiting_email_confirmation"
        log_payment_flow_diagnostics(session, stage="email_repeat")
        return PaymentTurnHint(force_reply=repeat_email_prompt(pending_offer))

    if pending_offer and is_email_confirmation(text):
        _confirm_payment_email(session)
        if get_canonical_confirmed_email(session) and session.payment_email_confirmed:
            return PaymentTurnHint(email_confirmed=True)
        logger.warning(
            "payment_email_confirm_failed sid=%s pending_offer_present=%s",
            session.call_sid[:6] if session.call_sid else "?",
            bool(pending_offer),
        )
        return PaymentTurnHint()

    email = extract_email_from_text(text)
    if email:
        set_pending_payment_email(session, email)
        log_payment_flow_diagnostics(session, stage="email_pending")
        return PaymentTurnHint(
            email_captured=True,
            force_reply=confirmation_prompt(email),
        )

    return PaymentTurnHint()


def resolve_tool_email(args: dict, session: "SessionState") -> str:
    """Return canonical confirmed email for payment send (never raw LLM args)."""
    sync_payment_email_fields(session)
    return get_canonical_confirmed_email(session)


def resolve_tool_email_arg(args: dict) -> str:
    """Read email from tool arguments only — for validation against confirmed."""
    for key in ("email", "customer_email", "to_email"):
        val = (args or {}).get(key) or ""
        if isinstance(val, str) and val.strip():
            return val.strip().lower()
    return ""


def build_payment_tool_result(
    *,
    success: bool,
    email_sent: bool = False,
    customer_message: str = "",
    error_code: str = "",
    retryable: bool = False,
    escalation_recommended: bool = False,
    internal_checkout_url: str = "",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "success": success,
        "email_sent": email_sent,
        "customer_message": customer_message,
        "error_code": error_code,
        "retryable": retryable,
        "escalation_recommended": escalation_recommended,
    }
    if customer_message:
        payload["error"] = customer_message  # backward-compat for legacy callers/tests
    if internal_checkout_url:
        payload["_internal_only"] = {"checkout_url": internal_checkout_url}
    return payload


def gate_send_payment_link(session: "SessionState", tool_email: str = "") -> PaymentGateResult:
    """Hard gate before send_payment_link executes."""
    from ..payment.email_state import assert_ready_for_payment_send

    _sync_legacy_email_fields(session)
    log_payment_flow_diagnostics(session, stage="gate_send_payment_link")

    if not _cart_has_confirmed_items(session):
        session.last_payment_attempt_status = "blocked"
        payload = build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=(
                "I need to confirm the book before I can send a payment link. "
                "Which book would you like to order?"
            ),
            error_code="no_cart",
            retryable=True,
        )
        return PaymentGateResult(allowed=False, tool_json=json.dumps(payload), reason="no_cart")

    if not assert_ready_for_payment_send(session, stage="gate_send_payment_link"):
        pending = get_pending_payment_email(session)
        if pending:
            msg = confirmation_prompt(pending)
        else:
            msg = (
                "I need a confirmed email address to send the payment link. "
                "What email should I use?"
            )
        session.last_payment_attempt_status = "blocked"
        payload = build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=msg,
            error_code="email_unconfirmed",
            retryable=True,
        )
        return PaymentGateResult(
            allowed=False, tool_json=json.dumps(payload), reason="email_unconfirmed",
        )

    if tool_email:
        from ..payment.safety import validate_tool_email_arg

        arg_result = validate_tool_email_arg(tool_email, session)
        if not arg_result.allowed:
            session.last_payment_attempt_status = "blocked"
            session.payment_block_count = getattr(session, "payment_block_count", 0) + 1
            payload = build_payment_tool_result(
                success=False,
                email_sent=False,
                customer_message=arg_result.safe_message,
                error_code=arg_result.reason,
                retryable=arg_result.reason in ("email_unconfirmed", "no_confirmed_email", "no_email"),
            )
            return PaymentGateResult(
                allowed=False, tool_json=json.dumps(payload), reason=arg_result.reason,
            )

    return PaymentGateResult(allowed=True)


def spoken_email_confirmation(session: "SessionState") -> Optional[str]:
    """
    Return the customer-facing email confirmation prompt with the FULL normalized
    email when we are awaiting confirmation.

    Payment email confirmation is an explicit exception to privacy masking rules:
    the caller must hear the complete address to verify it.
    """
    if not getattr(session, "awaiting_payment_email_confirmation", False):
        return None
    pending = get_pending_payment_email(session)
    if not pending:
        return None
    return confirmation_prompt(pending)


def enforce_payment_response(
    session: "SessionState",
    llm_text: str,
    tool_results: list[tuple[str, dict]],
) -> str:
    """
    Override LLM final text when payment tool results contradict it.
    """
    confirm = spoken_email_confirmation(session)
    if confirm:
        if not llm_text or _FALSE_SUCCESS_PAT.search(llm_text or "") or "***" in (llm_text or ""):
            return confirm
        if pending := get_pending_payment_email(session):
            if pending.lower() not in (llm_text or "").lower():
                return confirm

    blocked_checkout = [
        (n, r) for n, r in tool_results
        if n == "create_checkout" and not r.get("success", True)
    ]
    if blocked_checkout and _FALSE_SUCCESS_PAT.search(llm_text or ""):
        _name, result = blocked_checkout[-1]
        return result.get("error") or result.get("customer_message") or llm_text

    payment_calls = [(n, r) for n, r in tool_results if n == "send_payment_link"]
    if payment_calls:
        _name, result = payment_calls[-1]
        if result.get("success") and result.get("email_sent"):
            session.last_payment_attempt_status = "success"
            session.payment_flow_result = {"email_sent": True, "success": True}
            return result.get("customer_message") or PAYMENT_SUCCESS_MESSAGE
        session.last_payment_attempt_status = "failed"
        session.payment_flow_result = {"email_sent": False, "success": False}
        return result.get("customer_message") or PAYMENT_FAILURE_MESSAGE

    if session.awaiting_payment_email_confirmation:
        pending = session.pending_payment_email or session.pending_email
        if pending and _FALSE_SUCCESS_PAT.search(llm_text or ""):
            return confirmation_prompt(pending)

    return scrub_false_payment_claims(llm_text)


def parse_tool_result(result_str: str) -> dict:
    try:
        data = json.loads(result_str)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}
