#!/usr/bin/env python3
"""
Pre-deploy health gate — exit non-zero on critical production failures.

Usage:
    python scripts/pre_deploy_health_gate.py
    python scripts/pre_deploy_health_gate.py --skip-tests
    python scripts/pre_deploy_health_gate.py --quick-tests
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.deploy.pre_deploy_gate import critical_failures, gate_passed, run_all_checks  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Pre-deploy health gate")
    parser.add_argument("--skip-tests", action="store_true", help="Skip pytest gate")
    parser.add_argument("--quick-tests", action="store_true", help="Run subset of tests only")
    args = parser.parse_args()

    checks = run_all_checks(skip_tests=args.skip_tests, quick_tests=args.quick_tests)
    for c in checks:
        status = "PASS" if c.passed else ("FAIL" if c.critical else "WARN")
        print(f"[{status}] {c.name}: {c.detail}")

    if gate_passed(checks):
        print("pre_deploy_health_gate: PASS")
        return 0

    fails = critical_failures(checks)
    print(f"pre_deploy_health_gate: FAIL ({len(fails)} critical)")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
