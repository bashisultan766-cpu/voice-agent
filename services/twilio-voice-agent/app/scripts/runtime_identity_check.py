#!/usr/bin/env python3
"""
Runtime identity check (v4.25).

Usage:
    python -m app.scripts.runtime_identity_check

Fails loudly (exit 1) when the running tree is not the expected v4.23/v4.24+ release.
"""
from __future__ import annotations

import sys


def main() -> int:
    from app.agent_runtime.runtime_identity import (
        collect_runtime_identity,
        validate_runtime_identity,
    )

    identity = collect_runtime_identity()
    failures = validate_runtime_identity(identity)

    print("Runtime Identity Check (v4.25)")
    print("=" * 60)
    for key in (
        "process_cwd",
        "app_main_file",
        "active_release_path",
        "python_executable",
        "pm2_process_name",
        "git_commit",
        "git_branch",
        "git_status_clean",
        "master_prompt_path",
        "master_prompt_chars",
        "master_prompt_sections",
        "voice_sales_flow_version",
        "tool_progress_prompts_enabled",
        "payment_email_state_version",
        "email_capture_short_circuit_enabled",
        "payment_auto_send_enabled",
        "create_checkout_customer_facing",
        "send_payment_link_customer_facing",
        "create_checkout_present_in_tool_specs",
        "llm_tool_runtime_module",
        "commerce_flow_module",
        "tool_progress_module",
        "email_state_module",
    ):
        print(f"  {key}={identity.get(key)}")

    print("\n  v4_files_present:")
    for rel, ok in sorted((identity.get("v4_files_present") or {}).items()):
        print(f"    [{'PASS' if ok else 'FAIL'}] {rel}")

    print("\n  imports:")
    print(f"    process_payment_turn={'yes' if identity.get('process_payment_turn_imported') else 'NO'}")
    print(f"    dispatch_with_progress={'yes' if identity.get('dispatch_with_progress_imported') else 'NO'}")

    if failures:
        print("\nFAIL — runtime identity checks failed:")
        for f in failures:
            print(f"  - {f}")
        print("\nLikely cause: PM2 is serving an old release path, stale process, or wrong branch.")
        print("On VPS run: pm2 describe twilio-voice-agent && pm2 env twilio-voice-agent")
        return 1

    print("\nPASS — runtime identity matches expected v4.23/v4.24+ release.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
