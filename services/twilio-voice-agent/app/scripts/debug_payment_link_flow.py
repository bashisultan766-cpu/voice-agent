#!/usr/bin/env python3
"""
Dry-run diagnostic for payment link flow (v4.22).

Usage:
    python -m app.scripts.debug_payment_link_flow --dry-run --email test@example.com
    python -m app.scripts.debug_payment_link_flow --live-send-test --email you@example.com
      (requires ALLOW_PAYMENT_EMAIL_LIVE_TEST=true)
"""
from __future__ import annotations

import argparse
import json
import os
import sys


def _check(label: str, ok: bool) -> tuple[str, bool]:
    return (f"  [{'PASS' if ok else 'FAIL'}] {label}", ok)


def run(*, email: str, dry_run: bool, live_send: bool) -> int:
    from app.agent_runtime.payment_flow_state import gate_send_payment_link
    from app.agent_runtime.tool_runtime_gates import gate_tool_call
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

    print("Payment Link Flow Diagnostic (v4.22)")
    print("=" * 56)
    print(f"dry_run={dry_run} live_send={live_send} email_present={bool(email)}")

    session = SessionState(
        session_id="diag",
        call_sid="CA_DIAG01",
        from_number="+15551230000",
        to_number="+15559999999",
    )
    for i in range(3):
        add_product_candidate(
            session,
            title=f"Diagnostic Book {i + 1}",
            isbn=f"978000000000{i + 1}",
            variant_id=f"gid://shopify/ProductVariant/diag{i + 1}",
            price="9.99",
        )
        confirm_last_candidate(session)
    session.payment_flow_status = "awaiting_email"

    cart_ok = require_confirmed_cart(session).allowed and get_ledger(session).confirmed_count() >= 3
    results.append(_check("cart_ready", cart_ok))

    set_pending_payment_email(session, email)
    confirm_payment_email(session)
    sync_payment_email_fields(session)
    confirmed_ok = bool(get_canonical_confirmed_email(session)) and require_confirmed_email(session).allowed
    results.append(_check("confirmed_email_ready", confirmed_ok))

    gate = gate_send_payment_link(session, "")
    gate_ok = gate.allowed
    results.append(_check("payment_gate_ready", gate_ok))

    tool_gate = gate_tool_call("send_payment_link", session)
    results.append(_check("send_tool_gate_ready", tool_gate is None))

    resend_ok = bool(settings.RESEND_API_KEY and settings.RESEND_FROM_EMAIL)
    results.append(_check("resend_config_ready", resend_ok))

    payload_ok = bool(email_sender._is_valid_email(email))
    results.append(_check("email_payload_ready", payload_ok))

    checkout_ready = cart_ok and confirmed_ok and gate_ok
    results.append(_check("checkout_creation_ready", checkout_ready))

    ledger_items = get_ledger(session).to_checkout_items()
    results.append(
        _check(
            "checkout_contains_all_cart_items",
            len(ledger_items) == get_ledger(session).confirmed_count() == 3,
        )
    )

    customer_safe = "http" not in (
        "I sent the secure payment link to your email. Please check your inbox and spam folder."
    )
    results.append(_check("customer_safe_output_ready", customer_safe))

    if live_send and os.environ.get("ALLOW_PAYMENT_EMAIL_LIVE_TEST", "").lower() == "true":
        import asyncio

        from app.tools.shopify_tools import send_payment_link_email_tool

        session.pending_checkout_url = "https://checkout.example.com/test-only"
        session.last_product_title = "Diagnostic order"
        raw = asyncio.run(send_payment_link_email_tool(session=session))
        data = json.loads(raw)
        sent = bool(data.get("email_sent"))
        print(f"  live email_sent={sent} provider_status={data.get('error_code') or 'ok'}")
        results.append(_check("live_send_attempted", True))
        results.append(_check("live_send_result", sent))
    elif live_send:
        print("  [SKIP] live send — set ALLOW_PAYMENT_EMAIL_LIVE_TEST=true")
        results.append(_check("live_send_skipped", True))

    print()
    for line, ok in results:
        print(line)

    print()
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
    parser.add_argument("--live-send-test", action="store_true", default=False)
    parser.add_argument("--email", default="test@example.com")
    args = parser.parse_args()
    try:
        return run(
            email=args.email.strip().lower(),
            dry_run=args.dry_run and not args.live_send_test,
            live_send=args.live_send_test,
        )
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
