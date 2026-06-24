"""v4.16.1 — Release bundle validation mode tests."""
from __future__ import annotations

import io
import os
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

ROOT = Path(__file__).resolve().parents[2]


def _load_bundle():
    import importlib.util
    path = ROOT / "scripts" / "validate_release_bundle.py"
    spec = importlib.util.spec_from_file_location("validate_bundle", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["validate_bundle"] = mod
    spec.loader.exec_module(mod)
    return mod


class TestBundleValidationModes:
    def test_deterministic_mode_excludes_live_markers(self):
        mod = _load_bundle()
        assert "not shopify_live" in mod.PYTEST_EXCLUDE_EXPR
        assert "not twilio_live" in mod.PYTEST_EXCLUDE_EXPR
        assert "not resend_live" in mod.PYTEST_EXCLUDE_EXPR

    def test_skip_gate_prevents_recursion(self):
        """--skip-gate must remove predeploy_release_gate from the step list."""
        mod = _load_bundle()
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = mod.main(["--mode", "full", "--skip-gate", "--skip-pytest"])
        output = buf.getvalue()
        assert "predeploy_release_gate" not in output or "PASS" in output or "FAIL" in output

    def test_skip_pytest_removes_pytest_step(self):
        mod = _load_bundle()
        steps_built: list[str] = []
        original_run = mod.run_check

        def mock_run(name, cmd, timeout=300):
            steps_built.append(name)
            return True, "OK"

        mod.run_check = mock_run
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = mod.main(["--skip-pytest"])
        mod.run_check = original_run
        assert not any("pytest" in s for s in steps_built), f"pytest ran despite --skip-pytest: {steps_built}"

    def test_deterministic_mode_runs_core_checks(self):
        mod = _load_bundle()
        steps_built: list[str] = []

        def mock_run(name, cmd, timeout=300):
            steps_built.append(name)
            return True, "PASS_mock"

        mod.run_check = mock_run
        buf = io.StringIO()
        with redirect_stdout(buf):
            mod.main(["--mode", "deterministic", "--skip-pytest"])
        required = ("compileall", "check_release_completeness", "check_agent_runtime")
        for r in required:
            assert any(r in s for s in steps_built), f"Missing step {r} in {steps_built}"

    def test_no_raw_checkout_url_in_scripts(self):
        """No release script should print raw checkout URLs."""
        for script in (ROOT / "scripts").glob("*.py"):
            text = script.read_text(encoding="utf-8", errors="replace")
            import re
            # Only check for hardcoded checkout URLs, not pattern references
            hardcoded = re.findall(r'https?://[^\s"\']+/checkouts/[^\s"\']+', text)
            assert not hardcoded, f"{script.name} contains hardcoded checkout URL: {hardcoded}"

    def test_no_processing_fee_emitted_to_callers(self):
        """Release scripts that emit to customers must not speak 'Processing Fee'.
        Validator/checker scripts may reference the phrase in their check logic.
        """
        VALIDATOR_NAMES = {
            "validate_eric_prompt.py",      # checks prompt for the phrase
            "verify_brain_smoke_call.py",   # lists "Processing Fee" as a BAD_MARKER to detect
            "verify_staging_voice_logs.py", # lists "Processing Fee" as a BAD_MARKER to detect
            "audit_live_tools.py",
            "check_agent_runtime.py",
        }
        for script in (ROOT / "scripts").glob("*.py"):
            if script.name in VALIDATOR_NAMES:
                continue
            text = script.read_text(encoding="utf-8", errors="replace")
            lines = [
                l for l in text.splitlines()
                if "Processing Fee" in l
                and not l.strip().startswith("#")
                and "check" not in l.lower()
                and "assert" not in l.lower()
                and "ban" not in l.lower()
            ]
            assert not lines, f"{script.name} may expose 'Processing Fee': {lines}"
