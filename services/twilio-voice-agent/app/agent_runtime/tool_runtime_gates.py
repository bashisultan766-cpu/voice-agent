"""
Deterministic runtime gates for LLM tool side-effects (v4.20).

Called from ``llm_tools.dispatch`` before any backend implementation runs.
These gates enforce business flow order regardless of what the model requests.
"""
from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, Optional

from .payment_flow_state import (
    PaymentGateResult,
    _cart_has_confirmed_items,
    build_payment_tool_result,
    confirmation_prompt,
    gate_send_payment_link,
)
from .commerce_flow_state import gate_add_to_cart
from ..payment.email_state import get_pending_payment_email

if TYPE_CHECKING:
    from ..state.models import SessionState

_BLOCKED_ORDER_PHRASE = re.compile(
    r"\b(can'?t|cannot)\s+place\s+orders?\s+directly\b",
    re.I,
)
_GOOD_ORDER_PHRASE = (
    "I can help build your cart and send a secure payment link to your email."
)


def replace_blocked_order_phrase(text: str) -> str:
    """Swap the forbidden 'can't place orders' phrase with the approved wording."""
    if not text or not _BLOCKED_ORDER_PHRASE.search(text):
        return text
    return _BLOCKED_ORDER_PHRASE.sub(_GOOD_ORDER_PHRASE, text)


def _blocked(
    *,
    error_code: str,
    customer_message: str,
    retryable: bool = True,
) -> PaymentGateResult:
    payload = build_payment_tool_result(
        success=False,
        email_sent=False,
        customer_message=customer_message,
        error_code=error_code,
        retryable=retryable,
    )
    return PaymentGateResult(allowed=False, tool_json=json.dumps(payload), reason=error_code)


def _checkout_started(session: "SessionState") -> bool:
    return bool(getattr(session, "pending_checkout_url", "") or "")


def gate_tool_call(name: str, session: "SessionState | None") -> Optional[PaymentGateResult]:
    """
    Return a ``PaymentGateResult`` when the tool call must be blocked.

    ``None`` means the tool may proceed to its implementation.
    """
    if session is None:
        return None

    if name == "add_to_cart":
        if getattr(session, "awaiting_payment_email_confirmation", False):
            pending = get_pending_payment_email(session)
            msg = (
                confirmation_prompt(pending)
                if pending
                else (
                    "Before we add more books, I need to confirm your email address. "
                    "Is the email I have correct?"
                )
            )
            return _blocked(error_code="awaiting_email_confirmation", customer_message=msg)
        if _checkout_started(session) and getattr(session, "payment_flow_status", "") in (
            "awaiting_send_confirmation",
            "payment_sent",
        ):
            return _blocked(
                error_code="checkout_in_progress",
                customer_message=(
                    "Your payment link is already being prepared. "
                    "If you'd like to add another book, tell me the title or ISBN "
                    "and I'll update your cart before sending the link."
                ),
            )
        commerce_gate = gate_add_to_cart(session)
        if commerce_gate is not None:
            return commerce_gate
        return None

    if name == "create_checkout":
        if not _cart_has_confirmed_items(session):
            return _blocked(
                error_code="no_cart",
                customer_message=(
                    "I need at least one confirmed book in your cart before I can "
                    "create a payment link. Which book would you like to order?"
                ),
            )
        if not getattr(session, "payment_cart_confirmed", False):
            return _blocked(
                error_code="cart_unconfirmed",
                customer_message=(
                    "Please confirm the books in your cart before I create the payment link."
                ),
            )
        if getattr(session, "awaiting_payment_email_confirmation", False):
            pending = get_pending_payment_email(session)
            msg = confirmation_prompt(pending) if pending else (
                "I need to confirm your email address before creating the payment link. "
                "What email should I use?"
            )
            return _blocked(error_code="email_unconfirmed", customer_message=msg)
        if not getattr(session, "payment_email_confirmed", False) or not getattr(session, "email_verified", False):
            return _blocked(
                error_code="email_unconfirmed",
                customer_message=(
                    "I need a confirmed email address before I can create the payment link. "
                    "What email should I send it to?"
                ),
            )
        return None

    if name == "send_payment_link":
        from ..payment.safety import require_cart_customer_confirmed
        from ..observability.tool_events import log_tool_blocked

        cart_gate = require_cart_customer_confirmed(session)
        if not cart_gate.allowed:
            log_tool_blocked(session=session, tool_name=name, reason=cart_gate.reason)
            return _blocked(error_code=cart_gate.reason, customer_message=cart_gate.safe_message)
        gate = gate_send_payment_link(session)
        return gate if not gate.allowed else None

    if name == "send_facility_payment_link":
        if not getattr(session, "payment_email_confirmed", False):
            pending = get_pending_payment_email(session)
            msg = confirmation_prompt(pending) if pending else (
                "I need a confirmed email address before I can send that link. "
                "What email should I use?"
            )
            return _blocked(error_code="email_unconfirmed", customer_message=msg)
        return None

    return None
