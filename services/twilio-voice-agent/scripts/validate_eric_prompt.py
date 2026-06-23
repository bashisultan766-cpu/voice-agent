#!/usr/bin/env python3
"""Validate eric_system_prompt.md (v4.14). Safe — no prompt text printed."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def validate() -> list[str]:
    errors: list[str] = []

    prompt_path = ROOT / "app" / "data" / "eric_system_prompt.md"
    if not prompt_path.is_file():
        errors.append("MISSING: app/data/eric_system_prompt.md not found")
        return errors

    text = prompt_path.read_text(encoding="utf-8")
    text_lower = text.lower()

    # File exists
    errors.append("PASS: eric_system_prompt.md exists")

    # Contains "Eric"
    if "eric" in text_lower:
        errors.append("PASS: Contains 'Eric'")
    else:
        errors.append("FAIL: Does not contain 'Eric'")

    # Contains "SureShot Books"
    if "sureshot books" in text_lower:
        errors.append("PASS: Contains 'SureShot Books'")
    else:
        errors.append("FAIL: Does not contain 'SureShot Books'")

    # Contains boundary rules
    boundary_phrases = ["politics", "sports", "weather", "general knowledge"]
    found_boundary = all(p in text_lower for p in boundary_phrases)
    if found_boundary:
        errors.append("PASS: Contains boundary rules (politics, sports, weather, general knowledge)")
    else:
        errors.append("FAIL: Missing some boundary rules")

    # Does not contain "Available Tools" heading
    if "available tools" in text_lower:
        errors.append("FAIL: Contains 'Available Tools' heading from old ElevenLabs prompt")
    else:
        errors.append("PASS: No 'Available Tools' heading")

    # Does not contain raw internal tool names
    internal_tool_names = [
        "mainllmcomposer", "ericdialoguebrain", "worker_fanout",
        "llm_supervisor", "paymentsafetyguard", "sureshotcatalogsearch",
    ]
    bad_tools = [t for t in internal_tool_names if t in text_lower]
    if bad_tools:
        errors.append(f"FAIL: Contains raw internal tool names: {bad_tools}")
    else:
        errors.append("PASS: No raw internal tool names")

    # Length under safe limit
    max_chars = 12000
    if len(text) <= max_chars:
        errors.append(f"PASS: Length {len(text)} chars <= {max_chars} limit")
    else:
        errors.append(f"FAIL: Length {len(text)} > {max_chars} limit")

    return errors


def main() -> int:
    results = validate()
    errors_only = [r for r in results if r.startswith("FAIL")]
    passes = [r for r in results if r.startswith("PASS")]

    print("Eric Prompt Validation")
    print("=" * 40)
    for r in results:
        print(f"  {r}")
    print("=" * 40)
    print(f"  {len(passes)} passed, {len(errors_only)} failed")

    return 1 if errors_only else 0


if __name__ == "__main__":
    raise SystemExit(main())
