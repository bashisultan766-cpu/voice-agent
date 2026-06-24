#!/usr/bin/env python3
"""Live certification gate — Shopify/Twilio/Resend integration checks (v4.16.1).

Run this separately from the deterministic predeploy gate.
Requires live credentials. Safe to skip in CI if credentials are absent.

Usage:
    python scripts/live_certification_gate.py               # all live markers
    python scripts/live_certification_gate.py --shopify     # Shopify only
    python scripts/live_certification_gate.py --resend      # Resend only
    python scripts/live_certification_gate.py --all         # all markers
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _run(cmd: list[str], timeout: int = 300) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(ROOT), timeout=timeout)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        return 1, f"timed out after {timeout}s"
    except Exception as exc:
        return 1, str(exc)


def _credentials_present(marker: str) -> bool:
    from app.config import get_settings
    s = get_settings()
    if marker == "shopify_live":
        return bool(s.SHOPIFY_SHOP_DOMAIN and s.SHOPIFY_ADMIN_ACCESS_TOKEN)
    if marker == "resend_live":
        return bool(s.RESEND_API_KEY)
    if marker == "twilio_live":
        return bool(s.TWILIO_ACCOUNT_SID and s.TWILIO_AUTH_TOKEN)
    return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Live certification gate (v4.16.1)")
    parser.add_argument("--shopify", action="store_true", help="Run shopify_live tests")
    parser.add_argument("--resend", action="store_true", help="Run resend_live tests")
    parser.add_argument("--twilio", action="store_true", help="Run twilio_live tests")
    parser.add_argument("--all", dest="all_live", action="store_true", help="Run all live tests")
    args = parser.parse_args(argv)

    run_shopify = args.shopify or args.all_live or not any([args.shopify, args.resend, args.twilio, args.all_live])
    run_resend = args.resend or args.all_live
    run_twilio = args.twilio or args.all_live

    print("=== Live Certification Gate (v4.16.1) ===\n")

    results: list[tuple[str, str, str]] = []
    overall_pass = True

    def _add(name: str, status: str, detail: str = "") -> None:
        nonlocal overall_pass
        results.append((name, status, detail))
        if status == "FAIL":
            overall_pass = False

    # ── Shopify live certification ─────────────────────────────────────────────
    if run_shopify:
        if not _credentials_present("shopify_live"):
            print("[SKIPPED] shopify_live — missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN")
            _add("shopify_live pytest", "SKIPPED", "missing_credentials")
        else:
            print("Running shopify_live tests...")
            code, out = _run([sys.executable, "-m", "pytest", "-q", "-m", "shopify_live"])
            status = "PASS" if code == 0 else "FAIL"
            _add("shopify_live pytest", status, out.strip()[-120:] if code != 0 else "OK")
            print(f"[{status}] shopify_live pytest")

            print("Running catalog sync...")
            code, out = _run([sys.executable, "scripts/sync_shopify_catalog_index.py"], timeout=120)
            status = "PASS" if code == 0 else "FAIL"
            _add("sync_shopify_catalog_index", status, out.strip()[-120:] if code != 0 else "OK")
            print(f"[{status}] sync_shopify_catalog_index")

            for query in ["USA Today 5 day delivery 3 months", "People magazine 6 months"]:
                code, out = _run([sys.executable, "scripts/search_catalog_index.py", "--query", query, "--allow-empty"])
                _add(f"search_catalog_index '{query}'", "PASS" if code == 0 else "FAIL", out.strip()[-80:])
                print(f"[{'PASS' if code == 0 else 'FAIL'}] search_catalog_index '{query}'\n  {out.strip()[-80:]}")

            code, out = _run([sys.executable, "scripts/debug_shopify_catalog_coverage.py"])
            _add("debug_shopify_catalog_coverage", "PASS" if code == 0 else "FAIL", out.strip()[-80:])
            print(f"[{'PASS' if code == 0 else 'FAIL'}] debug_shopify_catalog_coverage")

            code, out = _run([sys.executable, "scripts/diagnose_catalog_visibility.py", "--query", "USA Today"])
            _add("diagnose_catalog_visibility USA Today", "PASS" if code == 0 else "FAIL", out.strip()[-80:])
            print(f"[{'PASS' if code == 0 else 'FAIL'}] diagnose_catalog_visibility")

    # ── Resend live certification ──────────────────────────────────────────────
    if run_resend:
        if not _credentials_present("resend_live"):
            print("[SKIPPED] resend_live — missing RESEND_API_KEY")
            _add("resend_live pytest", "SKIPPED", "missing_credentials")
        else:
            print("Running resend_live tests...")
            code, out = _run([sys.executable, "-m", "pytest", "-q", "-m", "resend_live"])
            status = "PASS" if code == 0 else "FAIL"
            _add("resend_live pytest", status, out.strip()[-120:] if code != 0 else "OK")
            print(f"[{status}] resend_live pytest")

    # ── Twilio live certification ──────────────────────────────────────────────
    if run_twilio:
        if not _credentials_present("twilio_live"):
            print("[SKIPPED] twilio_live — missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN")
            _add("twilio_live pytest", "SKIPPED", "missing_credentials")
        else:
            print("Running twilio_live tests...")
            code, out = _run([sys.executable, "-m", "pytest", "-q", "-m", "twilio_live"])
            status = "PASS" if code == 0 else "FAIL"
            _add("twilio_live pytest", status, out.strip()[-120:] if code != 0 else "OK")
            print(f"[{status}] twilio_live pytest")

    print()
    all_skipped = all(s == "SKIPPED" for _, s, _ in results)
    if all_skipped:
        print("LIVE_CERTIFICATION=SKIPPED reason=missing_credentials")
        return 0

    verdict = "PASS" if overall_pass else "FAIL"
    print(f"LIVE_CERTIFICATION={verdict}")
    if not overall_pass:
        print("Next action: fix failing live checks, then re-run.")
    else:
        print("Next action: run staging smoke call, then deploy.")
    return 0 if overall_pass else 1


if __name__ == "__main__":
    raise SystemExit(main())
