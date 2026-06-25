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

_FALSE_SUCCESS_PAT = re.compile(
    r"\b("
    r"sent|created|emailed|payment link|checkout link|"
    r"direct url|provided url|use the url|link from our conversation"
    r")\b",
    re.I,
)


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


def _sync_legacy_email_fields(session: "SessionState") -> None:
    """Keep v4.19 flags aligned with legacy pending_email / confirmed_email."""
    if session.pending_payment_email and not session.pending_email:
        session.pending_email = session.pending_payment_email
    if session.pending_email and not session.pending_payment_email:
        session.pending_payment_email = session.pending_email
    session.payment_email_confirmed = bool(session.confirmed_email)
    session.awaiting_payment_email_confirmation = bool(
        session.pending_payment_email and not session.payment_email_confirmed
    )


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


def extract_email_from_text(text: str) -> Optional[str]:
    if not text:
        return None
    typed = _EMAIL_TYPED.search(text)
    if typed:
        return typed.group(1).lower().strip()
    try:
        from ..pipeline.email_capture import normalize_spoken_email

        return normalize_spoken_email(text)
    except Exception:  # noqa: BLE001
        return None


def confirmation_prompt(email: str) -> str:
    return f"Just to confirm, I heard {email}. Is that correct?"


def _confirm_payment_email(session: "SessionState") -> None:
    email = (session.pending_payment_email or session.pending_email or "").strip()
    if not email:
        return
    session.confirmed_email = email
    session.caller_email = email
    session.pending_payment_email = ""
    session.pending_email = ""
    session.payment_email_confirmed = True
    session.awaiting_payment_email_confirmation = False
    session.email_confidence = "high"
    session.payment_flow_status = "awaiting_send_confirmation"
    session.last_payment_attempt_status = "confirmed"
    logger.info(
        "payment_email_confirmed sid=%s",
        session.call_sid[:6] if session.call_sid else "?",
    )


def _reject_pending_email(session: "SessionState") -> None:
    rejected = session.pending_payment_email or session.pending_email
    session.pending_payment_email = ""
    session.pending_email = ""
    session.awaiting_payment_email_confirmation = False
    session.payment_email_confirmed = False
    session.email_confidence = "low"
    session.email_rejected_count = getattr(session, "email_rejected_count", 0) + 1
    if rejected:
        candidates = getattr(session, "rejected_email_candidates", None) or []
        if rejected.lower() not in [c.lower() for c in candidates]:
            session.rejected_email_candidates = [*candidates, rejected]
    session.payment_flow_status = "awaiting_email"
    session.last_payment_attempt_status = "rejected"


def process_payment_turn(session: "SessionState", caller_text: str) -> PaymentTurnHint:
    """
    Update payment session state from caller text before the LLM runs.

    Returns a hint with ``force_reply`` when the runtime should speak a
    deterministic confirmation prompt instead of letting the LLM send payment.
    """
    _sync_legacy_email_fields(session)
    session.payment_cart_confirmed = _cart_has_confirmed_items(session)

    if not in_payment_flow(session):
        return PaymentTurnHint()

    text = (caller_text or "").strip()
    if not text:
        return PaymentTurnHint()

    try:
        from ..pipeline.email_capture import is_email_confirmation, is_email_correction
    except Exception:  # noqa: BLE001
        return PaymentTurnHint()

    if is_email_correction(text):
        _reject_pending_email(session)
        return PaymentTurnHint()

    awaiting = bool(
        getattr(session, "awaiting_payment_email_confirmation", False)
        or session.payment_flow_status == "awaiting_email_confirmation"
    )
    pending = session.pending_payment_email or session.pending_email

    if awaiting and pending and is_email_confirmation(text):
        _confirm_payment_email(session)
        return PaymentTurnHint(email_confirmed=True)

    email = extract_email_from_text(text)
    if email:
        session.pending_payment_email = email
        session.pending_email = email
        session.payment_email_confirmed = False
        session.awaiting_payment_email_confirmation = True
        session.payment_flow_status = "awaiting_email_confirmation"
        session.last_payment_attempt_status = "pending_confirmation"
        logger.info(
            "payment_email_pending_confirmation sid=%s",
            session.call_sid[:6] if session.call_sid else "?",
        )
        return PaymentTurnHint(
            email_captured=True,
            force_reply=confirmation_prompt(email),
        )

    return PaymentTurnHint()


def resolve_tool_email(args: dict, session: "SessionState") -> str:
    """Accept email / customer_email / to_email; fall back to session confirmed."""
    for key in ("email", "customer_email", "to_email"):
        val = (args or {}).get(key) or ""
        if isinstance(val, str) and val.strip():
            return val.strip().lower()
    return (getattr(session, "confirmed_email", "") or "").strip().lower()


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
    _sync_legacy_email_fields(session)

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

    if session.awaiting_payment_email_confirmation or not session.payment_email_confirmed:
        pending = session.pending_payment_email or session.pending_email
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

    from ..payment.safety import validate_tool_email_arg

    arg_result = validate_tool_email_arg(tool_email or None, session)
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


def enforce_payment_response(
    session: "SessionState",
    llm_text: str,
    tool_results: list[tuple[str, dict]],
) -> str:
    """
    Override LLM final text when payment tool results contradict it.
    """
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

    return llm_text


def parse_tool_result(result_str: str) -> dict:
    try:
        data = json.loads(result_str)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}
