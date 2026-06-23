#!/usr/bin/env python3
"""Verify required v4.15.1 release files are present. Safe — no secrets."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

REQUIRED_RELEASE_FILES = (
    "app/agent_runtime/prompt_pack_loader.py",
    "app/agent_runtime/llm_brain_contract.py",
    "app/agent_runtime/direct_llm_answerer.py",
    "app/agent_runtime/tool_eligibility_gate.py",
    "app/agent_runtime/fake_checking_guard.py",
    "app/payment/payment_idempotency.py",
    "app/payment/checkout_certifier.py",
    "app/payment/email_certifier.py",
    "app/data/prompt_pack/00_eric_core_identity.md",
    "app/data/prompt_pack/10_store_business_rules.md",
    "app/data/prompt_pack/20_dialogue_style.md",
    "app/data/prompt_pack/30_tool_use_policy.md",
    "app/data/prompt_pack/40_payment_safety_policy.md",
    "app/data/prompt_pack/50_examples_and_edge_cases.md",
    "scripts/print_prompt_pack_summary.py",
    "scripts/report_commerce_tools_inventory.py",
    "scripts/audit_end_to_end_commerce_flows.py",
    "scripts/audit_live_tools.py",
    "scripts/debug_shopify_catalog_coverage.py",
    "scripts/diagnose_catalog_visibility.py",
    "scripts/debug_order_lookup_route.py",
    "scripts/generate_live_demo_script.py",
    "scripts/predeploy_release_gate.py",
    "scripts/check_release_completeness.py",
    "scripts/validate_release_bundle.py",
)


def check_release_completeness(root: Path | None = None) -> tuple[bool, list[str]]:
    """Return (all_present, missing_relative_paths)."""
    base = root or ROOT
    missing: list[str] = []
    for rel in REQUIRED_RELEASE_FILES:
        if not (base / rel).is_file():
            missing.append(rel)
    return len(missing) == 0, missing


def main() -> int:
    ok, missing = check_release_completeness()
    if ok:
        print(f"RELEASE_COMPLETENESS=PASS ({len(REQUIRED_RELEASE_FILES)} files)")
        return 0
    print("RELEASE_COMPLETENESS=FAIL")
    print(f"Missing {len(missing)} required file(s):")
    for rel in missing:
        print(f"  - {rel}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
