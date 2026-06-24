#!/usr/bin/env python3
"""Release bundle validation (v4.16.1).

Modes:
  deterministic (default) — fast CI-safe checks, no live API calls, no recursion
  full                    — deterministic + predeploy gate (no live Shopify)
  live                    — full + live certification gate

Flags:
  --skip-gate       Do not call predeploy_release_gate.py (prevents mutual recursion)
  --skip-pytest     Skip pytest step (use when calling from gate to avoid double run)
  --mode MODE       Set validation mode (default: deterministic)
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PYTEST_EXCLUDE_EXPR = "not shopify_live and not twilio_live and not resend_live and not slow"

DETERMINISTIC_CHECKS: list[tuple[str, list[str]]] = [
    ("compileall", [sys.executable, "-m", "compileall", "app", "-q"]),
    ("check_release_completeness", [sys.executable, "scripts/check_release_completeness.py"]),
    ("check_agent_runtime", [sys.executable, "scripts/check_agent_runtime.py"]),
    ("validate_eric_prompt", [sys.executable, "scripts/validate_eric_prompt.py"]),
    ("print_prompt_pack_summary", [sys.executable, "scripts/print_prompt_pack_summary.py"]),
    ("sync_catalog_dry_run", [sys.executable, "scripts/sync_shopify_catalog_index.py", "--dry-run"]),
    (
        "search_catalog_allow_empty",
        [sys.executable, "scripts/search_catalog_index.py",
         "--query", "USA Today 5 day delivery 3 months", "--allow-empty"],
    ),
    ("verify_catalog_index_ready", [sys.executable, "scripts/verify_catalog_index_ready.py"]),
]

PYTEST_DETERMINISTIC: list[tuple[str, list[str]]] = [
    ("pytest_deterministic", [sys.executable, "-m", "pytest", "-q", "-m", PYTEST_EXCLUDE_EXPR]),
]


def run_check(name: str, cmd: list[str], timeout: int = 300) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            cmd, cwd=str(ROOT), capture_output=True, text=True, timeout=timeout,
        )
        output = (result.stdout or "") + (result.stderr or "")
        return result.returncode == 0, output.strip()
    except subprocess.TimeoutExpired:
        return False, f"timed out after {timeout}s"
    except Exception as exc:
        return False, str(exc)


def _catalog_ready_ok(output: str) -> bool:
    return "CATALOG_INDEX_READY=PASS" in output or "CATALOG_INDEX_READY=WARN" in output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Release bundle validation (v4.16.1)")
    parser.add_argument("--mode", choices=["deterministic", "full", "live"], default="deterministic")
    parser.add_argument("--skip-gate", action="store_true",
                        help="Skip predeploy_release_gate.py (prevents recursion)")
    parser.add_argument("--skip-pytest", action="store_true",
                        help="Skip pytest step (use when called from gate)")
    args = parser.parse_args(argv)

    print(f"=== Release Bundle Validation (v4.16.1) mode={args.mode} ===\n")

    steps: list[tuple[str, list[str], int]] = []

    if not args.skip_pytest:
        steps.extend([(n, c, 600) for n, c in PYTEST_DETERMINISTIC])

    steps.extend([(n, c, 60) for n, c in DETERMINISTIC_CHECKS])

    if args.mode in ("full", "live") and not args.skip_gate:
        steps.append((
            "predeploy_release_gate",
            [sys.executable, "scripts/predeploy_release_gate.py", "--skip-bundle-recursion"],
            600,
        ))

    if args.mode == "live":
        steps.append((
            "live_certification_gate",
            [sys.executable, "scripts/live_certification_gate.py"],
            600,
        ))

    for name, cmd, timeout in steps:
        print(f"Running {name}...")
        ok, output = run_check(name, cmd, timeout=timeout)

        # catalog readiness: WARN is not a failure
        if name == "verify_catalog_index_ready":
            ok = ok or _catalog_ready_ok(output)

        if output:
            tail = output[-1500:] if len(output) > 1500 else output
            print(tail)
        if not ok:
            print(f"\nRELEASE_BUNDLE_VALIDATION=FAIL at step: {name}")
            return 1
        print(f"[PASS] {name}\n")

    print("RELEASE_BUNDLE_VALIDATION=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
