#!/usr/bin/env python3
"""
Local diagnostic for the v4.26 payment email state machine.

Usage:
    python -m app.scripts.debug_payment_state_machine --email bashisultan766@gmail.com
"""
from __future__ import annotations

import argparse
import json
import os
import sys


def _check(label: str, ok: bool) -> tuple[str, bool]:
    return (f"  [{'PASS' if ok else 'FAIL'}] {label}", ok)


def run(email: str) -> int:
    from app.agent_runtime.payment_flow_state import gate_send_payment_link
    from app.cart.session import add_product_candidate, confirm_last_candidate, get_ledger
    from app.config import get_settings
    from app.payment.email_state import (
        confirm_payment_email,
        get_canonical_confirmed_email,
        get_pending_payment_email,
        sync_payment_email_fields,
    )
    from app.payment.payment_state_machine import capture_payment_email, process_payment_turn
    from app.pipeline.email_capture import normalize_spoken_email
    from app.pipeline.email_speller import speak_email, spell_email_for_voice
    from app.state.models import SessionState
    from app.tools import email_sender

    results: list[tuple[str, bool]] = []
    print("Payment State Machine Diagnostic (v4.26)")
    print("=" * 56)
    print(f"email={email}")

    normalized = normalize_spoken_email(email) or email.strip().lower()
    spoken = speak_email(normalized)
    spelled = spell_email_for_voice(normalized)
    results.append(_check("email_normalized", bool(normalized and "@" in normalized)))
    results.append(_check("email_spoken_with_dot", "dot" in spoken and "@" not in spoken and "." not in spoken))
    results.append(_check("email_spelled_with_dot", "dot" in spelled and "period" not in spelled.lower()))

    session = SessionState(
        session_id="diag-psm",
        call_sid="CA_DIAG_PSM",
        from_number="+15551230000",
        to_number="+15559999999",
    )
    add_product_candidate(
        session,
        title="Diagnostic Book",
        isbn="9780000000999",
        variant_id="gid://shopify/ProductVariant/diag",
        price="9.99",
    )
    confirm_last_candidate(session)
    session.payment_flow_status = "awaiting_email"

    hint = capture_payment_email(session, normalized)
    pending = get_pending_payment_email(session)
    results.append(_check("pending_email_set", pending == normalized))
    prompt = hint.force_reply or ""
    results.append(_check("confirmation_prompt_full_email", spoken in prompt and "***" not in prompt))
    results.append(_check("confirmation_prompt_spelled", spelled in prompt))
    results.append(_check("confirmation_not_masked", "***" not in prompt))

    yes_hint = process_payment_turn(session, "Yes, that's correct")
    sync_payment_email_fields(session)
    results.append(_check("yes_confirms_email", yes_hint.email_confirmed))
    results.append(_check("confirmed_email_present", get_canonical_confirmed_email(session) == normalized))

    cart_ok = get_ledger(session).confirmed_count() >= 1
    results.append(_check("cart_ready", cart_ok))

    settings = get_settings()
    resend_ok = bool(settings.RESEND_API_KEY and settings.RESEND_FROM_EMAIL)
    results.append(_check("resend_ready", resend_ok))

    session.pending_checkout_url = "https://checkout.example.com/dry-run-only"
    session.checkout_url = session.pending_checkout_url
    gate = gate_send_payment_link(session, "")
    results.append(_check("checkout_ready", bool(session.checkout_url)))
    results.append(_check("payment_gate_ready", gate.allowed))

    dry_ok = False
    if gate.allowed and email_sender._is_valid_email(normalized):
        dry_ok = True
    results.append(_check("payment_email_sent_dry_run", dry_ok))

    safe = (
        "inbox" in (
            "I sent the secure payment link to your email. Please check your inbox."
        ).lower()
        and "http" not in prompt.lower()
        and "direct link" not in prompt.lower()
    )
    results.append(_check("customer_safe_output", safe))

    for line, _ok in results:
        print(line)

    print()
    print("=" * 56)
    if all(ok for _, ok in results):
        print("PASS")
        return 0
    print("FAIL")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", default="bashisultan766@gmail.com")
    args = parser.parse_args()
    os.environ.setdefault("OPENAI_API_KEY", "test-key")
    return run(args.email)


if __name__ == "__main__":
    raise SystemExit(main())
