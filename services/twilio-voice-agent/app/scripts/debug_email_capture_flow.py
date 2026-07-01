#!/usr/bin/env python3
"""
Local diagnostic for email capture + confirmation (v4.22).

Usage:
    python -m app.scripts.debug_email_capture_flow
"""
from __future__ import annotations

import sys

CASES = [
    ("direct", "bashisultan766@gmail.com", "bashisultan766@gmail.com"),
    ("spoken", "bashi sultan 766 at gmail dot com", "bashisultan766@gmail.com"),
    (
        "spelled",
        "b a s h i s u l t a n 7 6 6 at g mail dot com",
        "bashisultan766@gmail.com",
    ),
    (
        "activate",
        "bashi sultan 766 activate gmail dot com",
        "bashisultan766@gmail.com",
    ),
    (
        "business",
        "first.last+tag at business-domain dot co",
        "first.last+tag@business-domain.co",
    ),
]


def _check(label: str, ok: bool) -> tuple[str, bool]:
    return (f"  [{'PASS' if ok else 'FAIL'}] {label}", ok)


def run_case(name: str, utterance: str, expected: str) -> list[tuple[str, bool]]:
    from app.agent_runtime.payment_flow_state import (
        confirmation_prompt,
        extract_email_from_text,
        process_payment_turn,
    )
    from app.cart.session import add_product_candidate, confirm_last_candidate
    from app.payment.email_state import (
        confirm_payment_email,
        get_canonical_confirmed_email,
        get_pending_payment_email,
        set_pending_payment_email,
        sync_payment_email_fields,
    )
    from app.email.capture import normalize_spoken_email
    from app.email.speller import speak_email, spell_email_for_voice
    from app.state.models import SessionState

    results: list[tuple[str, bool]] = []
    session = SessionState(
        session_id=f"diag-{name}",
        call_sid=f"CA_DIAG_{name}",
        from_number="+15551230000",
        to_number="+15559999999",
    )
    add_product_candidate(
        session,
        title="Diag Book",
        isbn="9780000000999",
        variant_id="gid://shopify/ProductVariant/diag",
        price="9.99",
    )
    confirm_last_candidate(session)
    session.payment_flow_status = "awaiting_email"

    normalized = extract_email_from_text(utterance) or normalize_spoken_email(utterance)
    results.append(_check(f"{name}/normalized_email", normalized == expected))

    hint = process_payment_turn(session, utterance)
    pending = get_pending_payment_email(session)
    results.append(_check(f"{name}/pending_email_set", pending == expected))

    prompt = hint.force_reply or confirmation_prompt(expected)
    spoken = speak_email(expected)
    spelled = spell_email_for_voice(expected)
    results.append(
        _check(
            f"{name}/confirmation_prompt_has_full_email",
            spoken in prompt and spelled in prompt and "***" not in prompt,
        )
    )

    yes_hint = process_payment_turn(session, "Yes. That's correct email.")
    sync_payment_email_fields(session)
    results.append(
        _check(
            f"{name}/yes_confirms_email",
            yes_hint.email_confirmed or bool(get_canonical_confirmed_email(session)),
        )
    )
    results.append(
        _check(
            f"{name}/confirmed_email_present",
            get_canonical_confirmed_email(session) == expected,
        )
    )
    results.append(
        _check(
            f"{name}/ready_for_payment_send",
            bool(session.payment_email_confirmed)
            and not session.awaiting_payment_email_confirmation
            and get_canonical_confirmed_email(session) == expected,
        )
    )

    # Reset for isolated confirm path test
    session2 = SessionState(
        session_id=f"diag2-{name}",
        call_sid=f"CA_DIAG2_{name}",
        from_number="+15551230000",
        to_number="+15559999999",
    )
    set_pending_payment_email(session2, expected)
    confirm_payment_email(session2)
    results.append(
        _check(
            f"{name}/confirm_payment_email_api",
            get_canonical_confirmed_email(session2) == expected,
        )
    )
    return results


def main() -> int:
    print("Email Capture Flow Diagnostic (v4.26)")
    print("=" * 56)
    all_results: list[tuple[str, bool]] = []
    for name, utterance, expected in CASES:
        print(f"\nCase: {name}")
        case_results = run_case(name, utterance, expected)
        all_results.extend(case_results)
        for line, _ok in case_results:
            print(line)

    print()
    print("=" * 56)
    if all(ok for _, ok in all_results):
        print("PASS")
        return 0
    print("FAIL")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
