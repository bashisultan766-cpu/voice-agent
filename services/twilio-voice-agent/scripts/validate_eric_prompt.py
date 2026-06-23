#!/usr/bin/env python3
"""Validate Eric prompt pack (v4.15.1). Safe — no prompt text printed."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_SECRET_PATTERNS = (
    re.compile(r"sk-[a-zA-Z0-9]{20,}"),
    re.compile(r"api[_-]?key\s*[:=]", re.I),
    re.compile(r"Bearer\s+[a-zA-Z0-9._-]{20,}"),
)

_REQUIRED_SECTIONS = (
    "eric",
    "sureshot books",
    "let me check",
    "how are you",
    "remember",
    "newspaper",
    "magazine",
)


def validate() -> list[str]:
    errors: list[str] = []
    pack_dir = ROOT / "app" / "data" / "prompt_pack"
    required_files = [
        "00_eric_core_identity.md",
        "10_store_business_rules.md",
        "20_dialogue_style.md",
        "30_tool_use_policy.md",
        "40_payment_safety_policy.md",
        "50_examples_and_edge_cases.md",
    ]

    if not pack_dir.is_dir():
        errors.append("FAIL: app/data/prompt_pack directory not found")
        return errors

    for name in required_files:
        fp = pack_dir / name
        if fp.is_file():
            errors.append(f"PASS: {name} exists")
        else:
            errors.append(f"FAIL: Missing {name}")

    combined = ""
    for name in sorted(required_files):
        fp = pack_dir / name
        if fp.is_file():
            combined += fp.read_text(encoding="utf-8") + "\n"

    combined_lower = combined.lower()

    if re.search(r"speak raw checkout url", combined_lower):
        if "never speak raw checkout" in combined_lower:
            errors.append("PASS: Raw checkout URL ban present")
        else:
            errors.append("FAIL: Prompt contains 'speak raw checkout URL' instruction")
    else:
        errors.append("PASS: No 'speak raw checkout URL' rule")

    if re.search(r"\bprocessing fee\b", combined_lower):
        if "never speak processing fee" in combined_lower or "never mention processing fee" in combined_lower:
            errors.append("PASS: Processing Fee mentioned only in safety ban")
        else:
            errors.append("FAIL: Prompt may instruct speaking Processing Fee")
    else:
        errors.append("PASS: No Processing Fee speak instruction")

    for section in _REQUIRED_SECTIONS:
        if section in combined_lower:
            errors.append(f"PASS: Contains '{section}' section/content")
        else:
            errors.append(f"FAIL: Missing '{section}' content")

    secrets_found = []
    for pat in _SECRET_PATTERNS:
        if pat.search(combined):
            secrets_found.append(pat.pattern[:30])
    if secrets_found:
        errors.append(f"FAIL: Possible secrets in prompt pack: {secrets_found}")
    else:
        errors.append("PASS: No secrets found")

    from app.config import get_settings

    s = get_settings()
    max_chars = getattr(s, "ERIC_PROMPT_MAX_CHARS", 60000)
    if len(combined) <= max_chars:
        errors.append(f"PASS: Total chars {len(combined)} <= {max_chars}")
    else:
        errors.append(f"FAIL: Total chars {len(combined)} > {max_chars}")

    legacy = ROOT / "app" / "data" / "eric_system_prompt.md"
    if legacy.is_file():
        errors.append("PASS: Legacy eric_system_prompt.md exists (backward compat)")
    else:
        errors.append("FAIL: Legacy eric_system_prompt.md missing")

    try:
        from app.agent_runtime.prompt_pack_loader import load_prompt_pack

        snap = load_prompt_pack(force_reload=True)
        errors.append(f"PASS: Prompt pack loads hash={snap.prompt_hash}")
    except Exception as exc:
        errors.append(f"FAIL: Prompt pack load error: {exc}")

    return errors


def main() -> int:
    results = validate()
    errors_only = [r for r in results if r.startswith("FAIL")]
    passes = [r for r in results if r.startswith("PASS")]

    print("Eric Prompt Validation (v4.15.1)")
    print("=" * 40)
    for r in results:
        print(r)
    print("=" * 40)
    print(f"PASS: {len(passes)}  FAIL: {len(errors_only)}")
    return 1 if errors_only else 0


if __name__ == "__main__":
    sys.exit(main())
