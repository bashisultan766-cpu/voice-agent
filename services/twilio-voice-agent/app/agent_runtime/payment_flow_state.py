"""
Payment flow compatibility layer (v4.26).

Gates, enforcement, and tool-result helpers. State transitions live in
``app.payment.payment_state_machine``; send logic in ``payment_link_service``.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Optional, TYPE_CHECKING

from ..payment.payment_link_service import (
    PAYMENT_FAILURE_MESSAGE,
    PAYMENT_SUCCESS_MESSAGE,
)
from ..payment.payment_state_machine import (
    PaymentTurnHint,
    _cart_has_confirmed_items,
    confirmation_prompt,
    email_capture_context_active,
    extract_email_from_text,
    in_payment_flow,
    process_payment_turn,
    repeat_email_prompt,
    speak_confirmation_prompt,
)

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

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
_RAW_URL_PAT = re.compile(r"https?://\S+", re.I)


def scrub_false_payment_claims(text: str) -> str:
    """Remove premature checkout/order claims and forbidden direct-link phrasing."""
    if not text:
        return text
    if _RAW_URL_PAT.search(text):
        return PAYMENT_FAILURE_MESSAGE
    if _DIRECT_LINK_PHRASE.search(text):
        return PAYMENT_FAILURE_MESSAGE
    if re.search(r"\border\s+(number\s+)?D\d+\b", text, re.I) and _FALSE_SUCCESS_PAT.search(text):
        return PAYMENT_FAILURE_MESSAGE
    return text


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
        payload["error"] = customer_message
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
        logger.error(
            "payment_send_blocked sid=%s reason=empty_cart",
            (session.call_sid or "")[:6],
        )
        payload = build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=(
                "I need to confirm the book before I can send a payment link. "
                "Which book would you like to order?"
            ),
            error_code="empty_cart",
            retryable=True,
        )
        return PaymentGateResult(allowed=False, tool_json=json.dumps(payload), reason="empty_cart")

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

    Payment email confirmation is an explicit exception to privacy masking rules.
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
    """Override LLM final text when payment tool results contradict it."""
    confirm = spoken_email_confirmation(session)
    if confirm:
        if not llm_text or _FALSE_SUCCESS_PAT.search(llm_text or "") or "***" in (llm_text or ""):
            return confirm
        if pending := get_pending_payment_email(session):
            local = pending.split("@", 1)[0]
            if local.lower() not in (llm_text or "").lower():
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
            session.email_send_success = True
            session.payment_link_sent = True
            return result.get("customer_message") or PAYMENT_SUCCESS_MESSAGE
        session.last_payment_attempt_status = "failed"
        session.payment_flow_result = {"email_sent": False, "success": False}
        session.email_send_success = False
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
