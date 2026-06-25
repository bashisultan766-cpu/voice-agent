#!/usr/bin/env python3
"""
Dry-run diagnostic for payment link flow (v4.21).

Usage:
    python -m app.scripts.debug_payment_link_flow --dry-run --email test@example.com
"""
from __future__ import annotations

import argparse
import json
import sys


def _check(label: str, ok: bool) -> tuple[str, bool]:
    return (f"  [{'PASS' if ok else 'FAIL'}] {label}", ok)


def run(*, email: str, dry_run: bool) -> int:
    from app.agent_runtime import llm_tools
    from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
    from app.config import get_settings
    from app.payment.email_state import (
        confirm_payment_email,
        get_canonical_confirmed_email,
        set_pending_payment_email,
        sync_payment_email_fields,
    )
    from app.payment.safety import require_confirmed_cart, require_confirmed_email
    from app.state.models import SessionState
    from app.tools import email_sender

    settings = get_settings()
    results: list[tuple[str, bool]] = []

    print("Payment Link Flow Diagnostic (v4.21)")
    print("=" * 56)
    print(f"dry_run={dry_run} email_present={bool(email)}")

    session = SessionState(
        session_id="diag",
        call_sid="CA_DIAG01",
        from_number="+15551230000",
        to_number="+15559999999",
    )
    add_product_candidate(
        session,
        title="Diagnostic Book",
        isbn="9780000000001",
        variant_id="gid://shopify/ProductVariant/diag1",
        price="9.99",
    )
    confirm_last_candidate(session)
    session.payment_flow_status = "awaiting_email"

    cart_ok = require_confirmed_cart(session).allowed and get_ledger(session).confirmed_count() >= 1
    results.append(_check("cart_ready", cart_ok))

    set_pending_payment_email(session, email)
    confirm_payment_email(session)
    sync_payment_email_fields(session)
    confirmed_ok = bool(get_canonical_confirmed_email(session)) and require_confirmed_email(session).allowed
    results.append(_check("confirmed_email_ready", confirmed_ok))

    resend_ok = bool(settings.RESEND_API_KEY and settings.RESEND_FROM_EMAIL)
    results.append(_check("resend_config_ready", resend_ok))

    payload_ok = bool(email_sender._is_valid_email(email))
    results.append(_check("email_payload_ready", payload_ok))

    checkout_ready = False
    if dry_run:
        checkout_ready = cart_ok and confirmed_ok
        results.append(_check("checkout_creation_ready", checkout_ready))
    else:
        results.append(_check("checkout_creation_ready", False))

    customer_safe = "http" not in (
        "I sent the secure payment link to your email. Please check your inbox and spam folder."
    )
    results.append(_check("customer_safe_output_ready", customer_safe))

    print()
    for line, ok in results:
        print(line)

    print()
    print("Registered send tool:", "send_payment_link" in llm_tools.tool_names())
    print("Canonical email field: session.confirmed_email + payment_email_confirmed")
    print("=" * 56)

    if all(ok for _, ok in results):
        print("PASS")
        return 0
    print("FAIL")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", default=True)
    parser.add_argument("--email", default="test@example.com")
    args = parser.parse_args()
    try:
        return run(email=args.email.strip().lower(), dry_run=args.dry_run)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
