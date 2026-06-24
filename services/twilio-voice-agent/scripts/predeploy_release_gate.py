#!/usr/bin/env python3
"""Pre-deploy release gate — deterministic production checks (v4.16.1).

Live Shopify/Twilio/Resend tests are excluded by default.
Run live_certification_gate.py separately for those.
"""
from __future__ import annotations

import argparse
import importlib.util
import io
import subprocess
import sys
from contextlib import redirect_stdout
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

LIVE_MARKERS = ("shopify_live", "twilio_live", "resend_live", "slow")
PYTEST_EXCLUDE_EXPR = "not shopify_live and not twilio_live and not resend_live and not slow"


@dataclass
class GateCheck:
    name: str
    command: str
    passed: bool
    detail: str = ""


def _check_release_completeness() -> GateCheck:
    import importlib.util

    path = ROOT / "scripts" / "check_release_completeness.py"
    spec = importlib.util.spec_from_file_location("check_release_completeness", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    ok, missing = mod.check_release_completeness(ROOT)
    detail = "OK" if ok else f"missing: {', '.join(missing[:5])}" + (
        f" (+{len(missing) - 5} more)" if len(missing) > 5 else ""
    )
    return GateCheck(
        "Release completeness",
        "scripts/check_release_completeness.py",
        ok,
        detail,
    )


def _run_cmd(cmd: list[str], cwd: Path) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(cwd), timeout=1200)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except Exception as exc:
        return 1, str(exc)


def _run_script(name: str) -> tuple[int, str]:
    path = ROOT / "scripts" / name
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = mod.main()
    return code, buf.getvalue()


def _check_env_not_staged() -> GateCheck:
    code, out = _run_cmd(["git", "diff", "--cached", "--name-only"], ROOT)
    staged = [l.strip() for l in out.splitlines() if l.strip()]
    env_staged = [f for f in staged if f.endswith(".env") or "/.env" in f]
    return GateCheck(
        "No .env staged",
        "git diff --cached --name-only",
        len(env_staged) == 0,
        f"staged env files: {env_staged}" if env_staged else "OK",
    )


def _check_openai_tools_blocked() -> GateCheck:
    from app.config import get_settings
    ok = get_settings().VOICE_LIVE_DISABLE_OPENAI_TOOLS is True
    ok = ok and get_settings().VOICE_AGENT_RUNTIME_MODE != "legacy_v410"
    return GateCheck(
        "OpenAI live tools blocked + no legacy_v410",
        "get_settings()",
        ok,
        f"tools_blocked={get_settings().VOICE_LIVE_DISABLE_OPENAI_TOOLS} mode={get_settings().VOICE_AGENT_RUNTIME_MODE}",
    )


def _check_payment_cert_dry_run() -> GateCheck:
    from app.payment.checkout_certifier import validate_checkout_payload
    from app.payment.email_certifier import validate_email_for_certification

    items = [{"variant_id": "v1", "quantity": 1, "title": "Book", "price": "$10"}]
    co = validate_checkout_payload(items)
    em = validate_email_for_certification("test@example.com", confirmed=True)
    ok = co.payload_valid and (em.success or em.blocked_reason == "not_allowlisted")
    return GateCheck("Payment certification dry-run", "validate_checkout_payload", ok, co.safe_message[:60])


def _check_idempotency() -> GateCheck:
    from app.payment.payment_idempotency import (
        check_idempotency,
        clear_idempotency_store,
        compute_idempotency_key,
        create_idempotency_record,
        mark_emailed,
    )

    clear_idempotency_store()
    key = compute_idempotency_key(
        call_sid="CAtest", group_id="g1",
        items=[{"variant_id": "v1", "quantity": 1}],
        confirmed_email="a@test.com",
    )
    create_idempotency_record(key, call_sid="CAtest", group_id="g1", items=[{"variant_id": "v1", "quantity": 1}], confirmed_email="a@test.com")
    blocked = check_idempotency(key)
    mark_emailed(key)
    blocked2 = check_idempotency(key)
    ok = not blocked.allowed and not blocked2.allowed
    clear_idempotency_store()
    return GateCheck("Idempotency tests inline", "payment_idempotency", ok, blocked2.action)


def _check_rollback_doc() -> GateCheck:
    path = ROOT / "docs" / "PRODUCTION_RELEASE_RUNBOOK_v4150.md"
    if not path.is_file():
        return GateCheck("Rollback runbook", str(path), False, "missing")
    text = path.read_text(encoding="utf-8")
    ok = "rollback" in text.lower() and "symlink" in text.lower()
    return GateCheck("Rollback instructions", str(path), ok, "present" if ok else "incomplete")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Pre-deploy release gate (v4.16.1)")
    parser.add_argument("--skip-bundle-recursion", action="store_true",
                        help="Do not call validate_release_bundle.py (prevents mutual recursion)")
    args = parser.parse_args(argv)

    print("=== Pre-Deploy Release Gate (v4.16.1) ===\n")
    print(f"Pytest scope: -m '{PYTEST_EXCLUDE_EXPR}'")
    print(f"LIVE_TESTS_SKIPPED={','.join(LIVE_MARKERS)}\n")

    completeness = _check_release_completeness()
    if not completeness.passed:
        print(f"[FAIL] {completeness.name}")
        print(f"  cmd: {completeness.command}")
        print(f"  reason: {completeness.detail}")
        print()
        print("RELEASE_GATE=FAIL")
        print("Next action: restore missing release files before running gate checks.")
        return 1

    print(f"[PASS] {completeness.name}")
    print(f"  cmd: {completeness.command}")
    print()

    checks: list[GateCheck] = [completeness]

    pytest_cmd = [sys.executable, "-m", "pytest", "-q", "-m", PYTEST_EXCLUDE_EXPR]
    cmd_checks = [
        (
            "check_release_completeness script",
            [sys.executable, "scripts/check_release_completeness.py"],
            lambda c, o: c == 0 and "RELEASE_COMPLETENESS=PASS" in o,
        ),
        (
            "pytest deterministic suite (live tests excluded)",
            pytest_cmd,
            lambda c, o: c == 0,
        ),
        ("compileall", [sys.executable, "-m", "compileall", "app", "-q"], lambda c, o: c == 0),
        ("check_agent_runtime", [sys.executable, "scripts/check_agent_runtime.py"], lambda c, o: c == 0),
        ("validate_eric_prompt", [sys.executable, "scripts/validate_eric_prompt.py"], lambda c, o: c == 0),
        ("print_prompt_pack_summary", [sys.executable, "scripts/print_prompt_pack_summary.py"], lambda c, o: c == 0),
        ("audit_live_tools", [sys.executable, "scripts/audit_live_tools.py"], lambda c, o: c == 0),
        ("report_commerce_tools_inventory", [sys.executable, "scripts/report_commerce_tools_inventory.py"], lambda c, o: c == 0),
        ("audit_end_to_end_commerce_flows", [sys.executable, "scripts/audit_end_to_end_commerce_flows.py"], lambda c, o: "14/14 OK" in o or c == 0),
        ("sync_catalog_index_dry_run", [sys.executable, "scripts/sync_shopify_catalog_index.py", "--dry-run"], lambda c, o: c == 0),
        (
            "search_catalog_index_allow_empty",
            [sys.executable, "scripts/search_catalog_index.py", "--query", "USA Today 5 day delivery 3 months", "--allow-empty"],
            lambda c, o: c == 0,
        ),
        ("verify_catalog_index_ready", [sys.executable, "scripts/verify_catalog_index_ready.py"], lambda c, o: "CATALOG_INDEX_READY=PASS" in o or "CATALOG_INDEX_READY=WARN" in o),
    ]

    for name, cmd, pred in cmd_checks:
        code, out = _run_cmd(cmd, ROOT)
        checks.append(GateCheck(name, " ".join(cmd), pred(code, out), out.strip()[-120:] if not pred(code, out) else "OK"))

    script_checks = [
        ("debug_shopify_catalog_coverage", "debug_shopify_catalog_coverage.py"),
        ("generate_live_demo_script", "generate_live_demo_script.py"),
    ]
    for name, script in script_checks:
        try:
            code, out = _run_script(script)
            checks.append(GateCheck(name, f"scripts/{script}", code == 0, "OK" if code == 0 else out[-80:]))
        except Exception as exc:
            checks.append(GateCheck(name, f"scripts/{script}", False, str(exc)))

    code, out = _run_cmd(
        [sys.executable, "scripts/diagnose_catalog_visibility.py", "--query", "USA Today"],
        ROOT,
    )
    checks.append(GateCheck(
        "diagnose_catalog_visibility USA Today",
        "diagnose_catalog_visibility.py --query USA Today",
        code == 0,
        "OK" if code == 0 else out[-80:],
    ))

    checks.extend([
        _check_payment_cert_dry_run(),
        _check_idempotency(),
        _check_env_not_staged(),
        _check_openai_tools_blocked(),
        _check_rollback_doc(),
    ])

    secret_ok = True
    for c in checks:
        if "sk-" in c.detail or "shpat_" in c.detail:
            secret_ok = False
    checks.append(GateCheck("No secrets in gate output", "heuristic", secret_ok, "OK" if secret_ok else "secrets found"))

    all_pass = True
    for c in checks:
        if c.name == completeness.name:
            continue
        status = "PASS" if c.passed else "FAIL"
        if not c.passed:
            all_pass = False
        print(f"[{status}] {c.name}")
        print(f"  cmd: {c.command}")
        if not c.passed:
            print(f"  reason: {c.detail[:200]}")
    print()
    print(f"LIVE_TESTS_SKIPPED={','.join(LIVE_MARKERS)}")
    print(f"RELEASE_GATE={'PASS' if all_pass else 'FAIL'}")
    if not all_pass:
        print("Next action: fix failing checks above before deploy.")
    else:
        print("Next action: run live_certification_gate.py, then staging smoke call, then deploy.")
    return 0 if all_pass else 1


if __name__ == "__main__":
    raise SystemExit(main())
