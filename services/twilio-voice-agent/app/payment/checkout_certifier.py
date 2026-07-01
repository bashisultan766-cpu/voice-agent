"""Shopify checkout certification — dry-run and staging real checkout (v4.15.0)."""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..payment.safety import _mask_email, require_confirmed_cart, require_confirmed_email
from .certification_config import allow_real_checkout, is_dry_run, max_cart_lines
from .payment_idempotency import (
    IdempotencyCheckResult,
    check_idempotency,
    compute_idempotency_key,
    create_idempotency_record,
    mark_checkout_created,
    mark_failed,
)

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_PROCESSING_FEE_PAT = re.compile(r"processing\s+fee", re.I)

FAILURE_CLASSES = (
    "invalid_variant",
    "unavailable_product",
    "shopify_api_error",
    "rate_limited",
    "network_timeout",
    "missing_customer_email",
    "duplicate_request",
    "unknown",
)


@dataclass
class CheckoutCertificationResult:
    success: bool
    dry_run: bool
    checkout_id: str = ""
    checkout_url: str = ""  # backend only — never spoken
    masked_checkout_hint: str = ""
    failure_class: str = ""
    safe_message: str = ""
    idempotency_key: str = ""
    idempotency_action: str = "proceed"
    payload_valid: bool = False


def _short_sid(sid: str) -> str:
    return sid[:6] if sid else "?"


def _classify_shopify_error(error: str) -> str:
    lower = (error or "").lower()
    if "variant" in lower or "invalid" in lower:
        return "invalid_variant"
    if "unavailable" in lower or "out of stock" in lower or "sold out" in lower:
        return "unavailable_product"
    if "rate" in lower or "429" in lower or "throttl" in lower:
        return "rate_limited"
    if "timeout" in lower or "timed out" in lower:
        return "network_timeout"
    if "email" in lower:
        return "missing_customer_email"
    if "shopify" in lower or "graphql" in lower or "api" in lower:
        return "shopify_api_error"
    return "unknown"


def safe_message_for_failure(failure_class: str) -> str:
    if failure_class == "invalid_variant":
        return (
            "I found the item, but I don't have a valid checkout option for it right now."
        )
    if failure_class == "unavailable_product":
        return (
            "I found the item, but it does not look available for checkout right now."
        )
    if failure_class == "duplicate_request":
        return "I'm already preparing that payment link."
    return (
        "I had trouble creating the payment link. I can try again or send this to customer service."
    )


def validate_checkout_payload(
    items: list[dict],
    *,
    session: "SessionState | None" = None,
    confirmed_email: str = "",
) -> CheckoutCertificationResult:
    """Dry-run validation of checkout payload."""
    if not items:
        return CheckoutCertificationResult(
            success=False,
            dry_run=True,
            failure_class="invalid_variant",
            safe_message=safe_message_for_failure("invalid_variant"),
        )

    if len(items) > max_cart_lines():
        return CheckoutCertificationResult(
            success=False,
            dry_run=True,
            failure_class="unknown",
            safe_message=(
                f"I can include up to {max_cart_lines()} items per payment link. "
                "Let's split your order into smaller groups."
            ),
        )

    for item in items:
        if not item.get("variant_id"):
            return CheckoutCertificationResult(
                success=False,
                dry_run=True,
                failure_class="invalid_variant",
                safe_message=safe_message_for_failure("invalid_variant"),
                payload_valid=False,
            )
        qty = int(item.get("quantity", 0) or 0)
        if qty < 1:
            return CheckoutCertificationResult(
                success=False,
                dry_run=True,
                failure_class="invalid_variant",
                safe_message=safe_message_for_failure("invalid_variant"),
                payload_valid=False,
            )

    if session is not None:
        cart_check = require_confirmed_cart(session, checkout_items=items)
        if not cart_check.allowed:
            return CheckoutCertificationResult(
                success=False,
                dry_run=True,
                failure_class="invalid_variant",
                safe_message=cart_check.safe_message or safe_message_for_failure("invalid_variant"),
            )
        if confirmed_email or getattr(session, "confirmed_email", ""):
            email_check = require_confirmed_email(session)
            if not email_check.allowed:
                return CheckoutCertificationResult(
                    success=False,
                    dry_run=True,
                    failure_class="missing_customer_email",
                    safe_message="I need to confirm the email before I send the payment link.",
                )

    subtotal = 0.0
    for item in items:
        price = str(item.get("price") or "").replace("$", "").replace(",", "").strip()
        try:
            if price:
                subtotal += float(price) * int(item.get("quantity", 1) or 1)
        except ValueError:
            pass

    return CheckoutCertificationResult(
        success=True,
        dry_run=True,
        payload_valid=True,
        safe_message="I created the payment link and I'm sending it to your email now.",
        masked_checkout_hint=f"subtotal~${subtotal:.2f}" if subtotal else "",
    )


async def certify_checkout(
    session: "SessionState",
    items: list[dict],
    *,
    group_id: str = "default",
    confirmed_email: str = "",
    force_retry: bool = False,
) -> CheckoutCertificationResult:
    """Validate and optionally create certified checkout."""
    email = confirmed_email or getattr(session, "confirmed_email", "") or ""
    key = compute_idempotency_key(
        call_sid=session.call_sid,
        group_id=group_id,
        items=items,
        confirmed_email=email,
    )

    idem = check_idempotency(key)
    if not idem.allowed and not force_retry:
        return CheckoutCertificationResult(
            success=False,
            dry_run=is_dry_run(),
            failure_class="duplicate_request",
            safe_message=idem.message,
            idempotency_key=key,
            idempotency_action=idem.action,
        )

    validation = validate_checkout_payload(items, session=session, confirmed_email=email)
    if not validation.payload_valid:
        return CheckoutCertificationResult(
            success=False,
            dry_run=is_dry_run(),
            failure_class=validation.failure_class or "invalid_variant",
            safe_message=validation.safe_message,
            idempotency_key=key,
        )

    if idem.action == "allow_retry" or idem.action == "proceed":
        create_idempotency_record(
            key,
            call_sid=session.call_sid,
            group_id=group_id,
            items=items,
            confirmed_email=email,
        )

    if is_dry_run() or not allow_real_checkout():
        checkout_id = f"dry_run_{key[:12]}"
        mark_checkout_created(key, checkout_id)
        logger.info(
            "checkout_certifier_dry_run sid=%s group_id=%s key=%s url_masked=True",
            _short_sid(session.call_sid),
            group_id[:8],
            key[:12],
        )
        return CheckoutCertificationResult(
            success=True,
            dry_run=True,
            checkout_id=checkout_id,
            checkout_url=f"https://checkout.example/dry/{checkout_id}",
            safe_message="I created the payment link and I'm sending it to your email now.",
            idempotency_key=key,
            payload_valid=True,
        )

    try:
        from ..tools.shopify_tools import create_checkout_link

        prev_cart = session.cart_items
        session.cart_items = items
        try:
            result_json = await create_checkout_link(
                items=items,
                email=email or None,
                customer_name=session.caller_name or None,
                session=session,
            )
        finally:
            session.cart_items = prev_cart

        result = json.loads(result_json)
        if not result.get("success"):
            failure = _classify_shopify_error(result.get("error", ""))
            mark_failed(key)
            return CheckoutCertificationResult(
                success=False,
                dry_run=False,
                failure_class=failure,
                safe_message=safe_message_for_failure(failure),
                idempotency_key=key,
            )

        checkout_url = result.get("checkout_url") or ""
        checkout_id = result.get("order_name") or result.get("draft_order_id") or key[:12]
        session.pending_checkout_url = checkout_url
        mark_checkout_created(key, str(checkout_id))
        logger.info(
            "checkout_certifier_success sid=%s group_id=%s checkout_id=%s url_masked=True",
            _short_sid(session.call_sid),
            group_id[:8],
            str(checkout_id)[:8],
        )
        return CheckoutCertificationResult(
            success=True,
            dry_run=False,
            checkout_id=str(checkout_id),
            checkout_url=checkout_url,
            safe_message="I created the payment link and I'm sending it to your email now.",
            idempotency_key=key,
            payload_valid=True,
        )
    except Exception as exc:
        logger.exception("checkout_certifier_error sid=%s", _short_sid(session.call_sid))
        mark_failed(key)
        failure = _classify_shopify_error(str(exc))
        return CheckoutCertificationResult(
            success=False,
            dry_run=False,
            failure_class=failure,
            safe_message=safe_message_for_failure(failure),
            idempotency_key=key,
        )


def contains_processing_fee(text: str) -> bool:
    return bool(_PROCESSING_FEE_PAT.search(text or ""))
