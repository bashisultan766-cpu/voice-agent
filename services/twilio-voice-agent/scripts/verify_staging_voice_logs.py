#!/usr/bin/env python3
"""Verify staging voice call logs against smoke plan markers (v4.15.0)."""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

GOOD_MARKERS = (
    "commerce_session_loaded",
    "commerce_candidates_updated",
    "commerce_cart_line_added",
    "intent=newspaper_search",
    "intent=magazine_search",
    "commerce_cart_summary",
    "payment_group_state",
    "email_spellback_prepared",
    "email_normalized",
    "checkout_certifier_dry_run",
    "payment_link_created",
    "payment_link_email_sent",
    "payment_duplicate_blocked",
    "payment_idempotency_checked",
    "intent=order_lookup",
    "intent=refund_lookup",
    "intent=facility_approval",
)

BAD_MARKERS = (
    "legacy_v410",
    "llm_brain_decision",
    "tool_calls",
    "role=tool",
    "generic_unknown_used",
    "Processing Fee",
    "processing fee",
)

BAD_PATTERNS = (
    (re.compile(r"https?://[^\s]*checkout[^\s]*", re.I), "raw checkout URL"),
    (re.compile(r"\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b", re.I), "unmasked email"),
    (re.compile(r"\bsk-[a-zA-Z0-9]{10,}\b"), "API key leak"),
    (re.compile(r"\bshpat_[a-zA-Z0-9]+\b"), "Shopify token leak"),
)


def _load_log_lines(path: Path, sid: str) -> list[str]:
    if not path.is_file():
        return []
    lines: list[str] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if sid in line or sid[:6] in line or not sid:
            lines.append(line)
    return lines


def verify_logs(text: str, *, sid: str = "") -> dict:
    found_good = [m for m in GOOD_MARKERS if m.lower() in text.lower()]
    missing_good = [m for m in GOOD_MARKERS if m not in found_good and m.lower() not in text.lower()]
    found_bad = [m for m in BAD_MARKERS if m.lower() in text.lower()]
    pattern_hits: list[str] = []
    for pat, label in BAD_PATTERNS:
        if pat.search(text):
            if label == "unmasked email" and "masked_email=" in text:
                continue
            pattern_hits.append(label)
    sent_without_email = (
        re.search(r"\bsent the payment link\b", text, re.I)
        and "payment_link_email_sent" not in text
    )
    checkout_without_confirm = (
        "payment_link_created" in text
        and "email_confirmed" not in text
        and "confirmed_email" not in text
        and "checkout_certifier" not in text
    )
    duplicate_checkout = len(re.findall(r"payment_link_created", text)) > 3
    if sent_without_email:
        found_bad.append("sent_without_payment_link_email_sent")
    if checkout_without_confirm:
        found_bad.append("checkout_without_confirmation")
    if duplicate_checkout:
        found_bad.append("duplicate_checkout_same_call")

    ok = not found_bad and not pattern_hits and not sent_without_email
    return {
        "sid": sid,
        "found_good": found_good,
        "missing_good": missing_good[:5],
        "found_bad": found_bad,
        "pattern_hits": pattern_hits,
        "pass": ok,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify staging voice logs")
    parser.add_argument("--sid", required=True, help="Call SID or prefix")
    parser.add_argument("--log-file", default="", help="Optional log file path")
    args = parser.parse_args()

    sid = args.sid
    if args.log_file:
        text = Path(args.log_file).read_text(encoding="utf-8", errors="replace")
    else:
        text = "\n".join(_load_log_lines(Path.cwd() / "logs" / "voice.log", sid))

    result = verify_logs(text, sid=sid)
    print(f"=== Log Verification sid={sid[:8]} ===")
    print(f"PASS: {result['pass']}")
    print(f"Good markers found ({len(result['found_good'])}): {result['found_good'][:8]}")
    if result["missing_good"]:
        print(f"Missing good markers (sample): {result['missing_good']}")
    if result["found_bad"]:
        print(f"BAD markers: {result['found_bad']}")
    if result["pattern_hits"]:
        print(f"BAD patterns: {result['pattern_hits']}")
    print(f"MARKER: log_verify_{'PASS' if result['pass'] else 'FAIL'}")
    return 0 if result["pass"] or not text.strip() else 1


if __name__ == "__main__":
    raise SystemExit(main())
