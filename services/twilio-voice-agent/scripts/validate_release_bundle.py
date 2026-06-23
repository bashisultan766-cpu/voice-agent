#!/usr/bin/env python3
"""Safe VPS release bundle validation — stops on first failure (v4.15.1a)."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

RELEASE_CHECKS: list[tuple[str, list[str]]] = [
    ("pytest", [sys.executable, "-m", "pytest", "-q"]),
    ("compileall", [sys.executable, "-m", "compileall", "app", "-q"]),
    ("check_release_completeness", [sys.executable, "scripts/check_release_completeness.py"]),
    ("check_agent_runtime", [sys.executable, "scripts/check_agent_runtime.py"]),
    ("validate_eric_prompt", [sys.executable, "scripts/validate_eric_prompt.py"]),
    ("print_prompt_pack_summary", [sys.executable, "scripts/print_prompt_pack_summary.py"]),
    ("predeploy_release_gate", [sys.executable, "scripts/predeploy_release_gate.py"]),
]


def run_check(name: str, cmd: list[str]) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            cmd,
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=600,
        )
        output = (result.stdout or "") + (result.stderr or "")
        return result.returncode == 0, output.strip()
    except Exception as exc:
        return False, str(exc)


def main() -> int:
    print("=== Release Bundle Validation (v4.15.1a) ===\n")
    for name, cmd in RELEASE_CHECKS:
        print(f"Running {name}...")
        ok, output = run_check(name, cmd)
        if output:
            tail = output[-2000:] if len(output) > 2000 else output
            print(tail)
        if not ok:
            print(f"\nRELEASE_BUNDLE_VALIDATION=FAIL at step: {name}")
            return 1
        print(f"[PASS] {name}\n")
    print("RELEASE_BUNDLE_VALIDATION=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
