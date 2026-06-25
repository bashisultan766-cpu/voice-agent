"""
PaymentSafetyGuard — central enforcement of payment email and checkout safety.

Single source of truth for all payment-path decisions. Called by:
  - PaymentEmailWorker (worker path)
  - send_payment_link_email_tool (LLM fallback path)
  - create_checkout_link (both paths)
  - CheckoutWorker (worker path)

Rules enforced here:
  1. confirmed_email must exist in session email state machine.
  2. pending_email is NEVER sufficient — only confirmed_email.
  3. Rejected email candidates (stored in session.rejected_email_candidates)
     can never be reintroduced by tool arguments.
  4. If LLM passes an email argument, it is validated against confirmed_email:
     - Match → proceed using confirmed_email (not the raw arg)
     - Mismatch → block, require reconfirmation
     - No confirmed_email at all → block
  5. Cart must have items with quantity ≥ 1 and variant_id set before checkout.
  6. No full email address ever appears in log output.

Security properties:
  - Raw LLM email args are never trusted without confirmed_email match.
  - Rejected candidates are stored across the call and cannot be reused.
  - confirmed_email is only set by the deterministic state machine in engine.py.
  - This module is pure deterministic Python — no I/O, no LLM calls.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState


def _mask_email(email: str) -> str:
    """Return masked email for safe logging: a***@domain.com."""
    if not email or "@" not in email:
        return "***@***"
    local, domain = email.split("@", 1)
    if len(local) <= 1:
        return f"***@{domain}"
    return f"{local[0]}***@{domain}"


@dataclass
class PaymentSafetyResult:
    """Result of a PaymentSafetyGuard check."""
    allowed: bool
    reason: str                          # internal reason code (never sent to LLM)
    safe_message: str                    # safe to return to caller / tool result
    confirmed_email_masked: str = ""     # masked form for logging; empty if not set
    missing_fields: list[str] = field(default_factory=list)


# ── Primary guard functions ────────────────────────────────────────────────────

def get_confirmed_email(session: "SessionState") -> Optional[str]:
    """
    Return canonical confirmed payment email or None.
    """
    from ..payment.email_state import get_canonical_confirmed_email

    email = get_canonical_confirmed_email(session)
    return email if email else None


def require_confirmed_email(session: "SessionState") -> PaymentSafetyResult:
    """
    Check that session has a confirmed email.

    Returns allowed=True only if confirmed_email is set and payment_email_confirmed.
    """
    from ..payment.email_state import (
        get_canonical_confirmed_email,
        get_pending_payment_email,
        sync_payment_email_fields,
    )

    sync_payment_email_fields(session)
    confirmed = get_canonical_confirmed_email(session)
    pending = get_pending_payment_email(session)
    rejected_count = getattr(session, "email_rejected_count", 0)

    if confirmed and getattr(session, "payment_email_confirmed", False):
        return PaymentSafetyResult(
            allowed=True,
            reason="confirmed",
            safe_message="",
            confirmed_email_masked=_mask_email(confirmed),
        )

    if pending:
        return PaymentSafetyResult(
            allowed=False,
            reason="email_unconfirmed",
            safe_message=(
                "I have an email address on file but it hasn't been confirmed yet. "
                "Is that email correct? Please say yes or no."
            ),
            missing_fields=["email_confirmation"],
        )

    if rejected_count > 0:
        return PaymentSafetyResult(
            allowed=False,
            reason="email_rejected",
            safe_message=(
                "The email address wasn't confirmed. "
                "Could you give me your email address again?"
            ),
            missing_fields=["email"],
        )

    return PaymentSafetyResult(
        allowed=False,
        reason="no_email",
        safe_message=(
            "I need a confirmed email address to send the payment link. "
            "Could you give me your email address?"
        ),
        missing_fields=["email"],
    )


def require_confirmed_cart(
    session: "SessionState",
    checkout_items: list[dict] | None = None,
) -> PaymentSafetyResult:
    """
    Check that session cart has items, each with quantity >= 1 and variant_id.
    """
    items: list[dict] = list(checkout_items or [])
    if not items:
        try:
            from ..cart.session import get_ledger

            items = get_ledger(session).to_checkout_items()
        except Exception:  # noqa: BLE001
            items = getattr(session, "cart_items", None) or []

    if not items:
        return PaymentSafetyResult(
            allowed=False,
            reason="no_items",
            safe_message=(
                "I need to confirm the book before I create the payment link. "
                "Which book would you like to order?"
            ),
            missing_fields=["cart_items"],
        )

    bad_qty = [i for i in items if int(i.get("quantity", 0) or 0) < 1]
    if bad_qty:
        return PaymentSafetyResult(
            allowed=False,
            reason="invalid_quantity",
            safe_message=(
                "I need to confirm the quantity before I create the payment link. "
                "How many copies would you like?"
            ),
            missing_fields=["quantity"],
        )

    missing_variant = [i for i in items if not i.get("variant_id")]
    if missing_variant:
        return PaymentSafetyResult(
            allowed=False,
            reason="no_variant",
            safe_message=(
                "I couldn't identify all items in your order. "
                "Could you confirm the title again?"
            ),
            missing_fields=["variant_id"],
        )

    return PaymentSafetyResult(
        allowed=True,
        reason="cart_ok",
        safe_message="",
    )


def require_payment_send_ready(session: "SessionState") -> PaymentSafetyResult:
    """
    Full gate for send_payment_link email delivery.

    Requires canonical confirmed_email. Checkout URL may be created inside
    SendPaymentLink immediately before this check when absent.
    """
    email_result = require_confirmed_email(session)
    if not email_result.allowed:
        return email_result

    return PaymentSafetyResult(
        allowed=True,
        reason="ready",
        safe_message="",
        confirmed_email_masked=email_result.confirmed_email_masked,
    )


def require_payment_send_ready_with_checkout(session: "SessionState") -> PaymentSafetyResult:
    """Gate when checkout URL must already exist (email-only resend)."""
    ready = require_payment_send_ready(session)
    if not ready.allowed:
        return ready

    checkout_url = getattr(session, "pending_checkout_url", "") or ""
    if not checkout_url:
        return PaymentSafetyResult(
            allowed=False,
            reason="no_checkout_url",
            safe_message=(
                "No payment link has been created yet. "
                "Would you like me to create one?"
            ),
            missing_fields=["checkout_url"],
        )

    return ready


def validate_tool_email_arg(
    tool_email_arg: Optional[str],
    session: "SessionState",
) -> PaymentSafetyResult:
    """
    Validate an email argument passed by the LLM tool call.

    Raw LLM email args never bypass confirmation — only session.confirmed_email is used.
    """
    from ..payment.email_state import (
        get_canonical_confirmed_email,
        get_pending_payment_email,
        sync_payment_email_fields,
    )

    sync_payment_email_fields(session)
    confirmed = get_canonical_confirmed_email(session)
    rejected_candidates: list[str] = getattr(session, "rejected_email_candidates", None) or []
    pending = get_pending_payment_email(session)

    if tool_email_arg and tool_email_arg.lower().strip() in [
        r.lower().strip() for r in rejected_candidates
    ]:
        return PaymentSafetyResult(
            allowed=False,
            reason="rejected_candidate",
            safe_message=(
                "That email address was not confirmed during this call. "
                "Could you give me the correct email address?"
            ),
        )

    if not confirmed or not getattr(session, "payment_email_confirmed", False):
        if pending:
            return PaymentSafetyResult(
                allowed=False,
                reason="email_unconfirmed",
                safe_message=(
                    "I need to confirm your email address before sending. "
                    "Is the email I have on file correct? Please say yes or no."
                ),
            )
        return PaymentSafetyResult(
            allowed=False,
            reason="no_confirmed_email",
            safe_message=(
                "I need a confirmed email address to send the payment link. "
                "Could you give me your email address?"
            ),
            missing_fields=["email"],
        )

    if tool_email_arg and tool_email_arg.strip():
        if tool_email_arg.lower().strip() != confirmed.lower().strip():
            return PaymentSafetyResult(
                allowed=False,
                reason="email_mismatch",
                safe_message=(
                    "I need to send the payment link to your confirmed email address. "
                    "Is that still correct?"
                ),
                confirmed_email_masked=_mask_email(confirmed),
            )

    return PaymentSafetyResult(
        allowed=True,
        reason="email_ok",
        safe_message="",
        confirmed_email_masked=_mask_email(confirmed),
    )
