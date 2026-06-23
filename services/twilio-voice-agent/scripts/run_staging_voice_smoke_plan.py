#!/usr/bin/env python3
"""Staging voice smoke call checklist (v4.15.0). Does not place calls automatically."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

SCENARIOS = [
    ("A", "Identity/job", "Hi, I'm calling about ordering books for an inmate.", "greeting", "small_talk,conversation_memory", "Greeting + offer to help", "PASS: commerce_session_loaded"),
    ("B", "ISBN book search", "The ISBN number is 9798994835500.", "isbn_lookup", "product_isbn,universal_catalog_search", "Found [title]. Would you like me to add this?", "PASS: commerce_candidates_updated"),
    ("C", "Add book", "Yes, add it.", "add_selected", "cart_mutation", "I added [title] to your order.", "PASS: commerce_cart_line_added"),
    ("D", "USA Today newspaper", "I need USA Today 5 Day Delivery For 3 Months.", "newspaper_search", "universal_catalog_search", "Found USA Today subscription.", "PASS: intent=newspaper_search"),
    ("E", "Add newspaper", "Add it.", "add_selected", "cart_mutation", "I added USA Today to your order.", "PASS: product_kind=newspaper"),
    ("F", "People magazine", "I need People magazine for 6 months.", "magazine_search", "universal_catalog_search", "Found People magazine.", "PASS: intent=magazine_search"),
    ("G", "Add magazine", "Add it.", "add_selected", "cart_mutation", "I added People magazine.", "PASS: commerce_cart_line_added"),
    ("H", "Cart summary mixed", "How many items are in my order?", "cart_summary", "cart_memory", "You have 3 items in your order", "PASS: commerce_cart_summary lines=3"),
    ("I", "Split payment 2 groups", "Send these 2 books to bashi at gmail dot com and the newspaper to orders at company dot com.", "payment_flow", "payment_flow", "two separate payment links", "PASS: payment_group_state"),
    ("J", "Gmail spellback", "bashi sultan 766 at gmail dot com", "email_capture", "email_fragment", "I heard ... Is that correct?", "PASS: email_spellback_prepared"),
    ("K", "Domain email spellback", "orders at company dot com", "email_capture", "email_fragment", "I heard ... Is that correct?", "PASS: email_normalized masked_email="),
    ("L", "Checkout creation", "Yes, send the payment link.", "payment_flow", "checkout,payment_flow", "I created the payment link", "PASS: checkout_certifier_dry_run OR payment_link_created url_masked=True"),
    ("M", "Resend email", "(after checkout)", "payment_flow", "payment_email", "I sent the payment link to b***@", "PASS: payment_link_email_sent masked_email="),
    ("N", "Duplicate blocked", "Send the payment link again.", "payment_flow", "payment_idempotency", "I already sent that payment link", "PASS: payment_duplicate_blocked"),
    ("O", "Order lookup", "Order number is 1234.", "order_lookup", "order_lookup", "Let me look that up.", "PASS: intent=order_lookup"),
    ("P", "Refund route", "Refund status for order 1234.", "refund_lookup", "refund", "Let me check refund status.", "PASS: intent=refund_lookup"),
    ("Q", "Facility restriction", "Does this facility allow magazines?", "facility_approval", "facility_approval", "Let me check facility rules.", "PASS: intent=facility_approval"),
]


def main() -> int:
    print("=== Staging Voice Smoke Plan (v4.15.0) ===\n")
    for code, name, phrase, intent, workers, voice, marker in SCENARIOS:
        print(f"[{code}] {name}")
        print(f"  SAY: \"{phrase}\"")
        print(f"  EXPECTED INTENT: {intent}")
        print(f"  EXPECTED WORKERS/LOGS: {workers}")
        print(f"  EXPECTED VOICE: {voice}")
        print(f"  PASS MARKER: {marker}")
        print()
    print("MARKER: staging_smoke_plan_v4150_complete")
    print(f"Total scenarios: {len(SCENARIOS)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
