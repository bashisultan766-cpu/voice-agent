#!/usr/bin/env python3
"""Generate 5-minute live demo script (v4.14.9)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

DEMO_STEPS = [
    {
        "step": 1,
        "name": "Identity/job",
        "say": "Hi, I'm calling about ordering books for an inmate.",
        "expected_speech": "Greeting + offer to help with books/publications",
        "expected_logs": "commerce_session_loaded, business_intent_resolved",
        "pass": "Agent identifies commerce intent",
        "fail": "Agent confuses with company identity",
    },
    {
        "step": 2,
        "name": "Book ISBN search",
        "say": "The ISBN number is 9798994835500.",
        "expected_speech": "Found [title] for [price]. Would you like me to add this to your order?",
        "expected_logs": "tool_entities_extracted keys=['isbn'], commerce_candidates_updated",
        "pass": "ISBN routed to isbn_lookup, candidate returned",
        "fail": "No search or wrong intent",
    },
    {
        "step": 3,
        "name": "Add book",
        "say": "Yes, add it.",
        "expected_speech": "I added [title] to your order.",
        "expected_logs": "commerce_cart_line_added, commerce_auto_add_selected",
        "pass": "Cart line with valid variant_id",
        "fail": "Add blocked or no cart line",
    },
    {
        "step": 4,
        "name": "Newspaper search",
        "say": "I also need USA Today 5 Day Delivery For 3 Months.",
        "expected_speech": "Found USA Today [subscription details]. Would you like me to add this?",
        "expected_logs": "intent=newspaper_search, universal_catalog_search",
        "pass": "Newspaper candidate from universal catalog",
        "fail": "Routed to book search only",
    },
    {
        "step": 5,
        "name": "Add newspaper",
        "say": "Add it.",
        "expected_speech": "I added USA Today to your order.",
        "expected_logs": "commerce_cart_line_added product_kind=newspaper",
        "pass": "Mixed cart has book + newspaper",
        "fail": "Replaced book or failed add",
    },
    {
        "step": 6,
        "name": "Magazine search",
        "say": "I need People magazine for 6 months.",
        "expected_speech": "Found People magazine. Would you like me to add this?",
        "expected_logs": "intent=magazine_search",
        "pass": "Magazine candidate returned",
        "fail": "Not found or wrong product kind",
    },
    {
        "step": 7,
        "name": "Add magazine",
        "say": "Add it.",
        "expected_speech": "I added People magazine to your order.",
        "expected_logs": "commerce_cart_line_added",
        "pass": "3 items in cart",
        "fail": "Cart count wrong",
    },
    {
        "step": 8,
        "name": "Cart summary",
        "say": "How many items are in my order?",
        "expected_speech": "You have 3 items in your order: [item 1], [item 2], and [item 3].",
        "expected_logs": "commerce_cart_summary lines=3",
        "pass": "Uses 'items' for mixed catalog",
        "fail": "Says 'books' for mixed cart",
    },
    {
        "step": 9,
        "name": "Multiple payment groups",
        "say": "Send the book to bashi at gmail dot com and the newspaper and magazine to orders at company dot com.",
        "expected_speech": "Got it. I'll keep those as two separate payment links.",
        "expected_logs": "payment_group_state, commerce_destination_group_updated",
        "pass": "Two DestinationGroup objects created",
        "fail": "Single group or line mix-up",
    },
    {
        "step": 10,
        "name": "Email spellback",
        "say": "bashi sultan 766 at gmail dot com",
        "expected_speech": "I heard bashi dot sultan766 at gmail dot com. Is that correct?",
        "expected_logs": "email_capture_started, email_normalized masked_email=***, email_spellback_prepared",
        "pass": "Spellback without full email in logs",
        "fail": "Raw email in logs or no spellback",
    },
    {
        "step": 11,
        "name": "Payment link sent (dry-run)",
        "say": "Yes, that's correct. Send the payment link.",
        "expected_speech": "I sent the payment link to b***@gmail.com.",
        "expected_logs": "payment_link_created url_masked=True, payment_link_email_sent masked_email=***",
        "pass": "Checkout + Resend success before 'sent'",
        "fail": "Says 'sent' before backend confirms",
    },
    {
        "step": 12,
        "name": "Order lookup route",
        "say": "What's the status of order number 1234?",
        "expected_speech": "Let me look that up. [order status from facts]",
        "expected_logs": "intent=order_lookup, order_lookup worker",
        "pass": "Routes to order_lookup worker",
        "fail": "Routed to catalog or invented status",
    },
    {
        "step": 13,
        "name": "Facility rule route",
        "say": "Does this facility allow magazines?",
        "expected_speech": "Let me check facility rules for magazines.",
        "expected_logs": "intent=facility_approval, facility_approval worker",
        "pass": "Facility worker invoked",
        "fail": "Generic answer without facility lookup",
    },
]


def main() -> int:
    print("=== Live Demo Script (v4.14.9) — ~5 minutes ===\n")
    for step in DEMO_STEPS:
        print(f"Step {step['step']}: {step['name']}")
        print(f"  SAY: \"{step['say']}\"")
        print(f"  EXPECTED SPEECH: {step['expected_speech']}")
        print(f"  EXPECTED LOGS: {step['expected_logs']}")
        print(f"  PASS: {step['pass']}")
        print(f"  FAIL: {step['fail']}")
        print()
    print(f"Total steps: {len(DEMO_STEPS)}")
    print("MARKER: demo_script_v4149_complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
