"""v4.16.1 — Release gate isolation: pytest marker strategy tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


class TestReleaseGateIsolation:
    def test_pytest_ini_has_markers(self):
        """pytest.ini must declare all required markers."""
        from pathlib import Path
        ini = (Path(__file__).resolve().parents[2] / "pytest.ini").read_text(encoding="utf-8")
        for marker in ("shopify_live", "twilio_live", "resend_live", "slow", "unit", "integration", "release_gate"):
            assert marker in ini, f"pytest.ini missing marker: {marker}"

    def test_predeploy_gate_excludes_live_markers(self):
        """predeploy_release_gate.py must contain the exclusion expression."""
        from pathlib import Path
        script = (Path(__file__).resolve().parents[2] / "scripts" / "predeploy_release_gate.py").read_text(encoding="utf-8")
        assert "not shopify_live" in script
        assert "not twilio_live" in script
        assert "not resend_live" in script
        assert "not slow" in script

    def test_predeploy_gate_prints_live_tests_skipped(self):
        """predeploy_release_gate.py must print LIVE_TESTS_SKIPPED."""
        from pathlib import Path
        script = (Path(__file__).resolve().parents[2] / "scripts" / "predeploy_release_gate.py").read_text(encoding="utf-8")
        assert "LIVE_TESTS_SKIPPED" in script

    def test_live_certification_gate_exists(self):
        """live_certification_gate.py must exist."""
        from pathlib import Path
        path = Path(__file__).resolve().parents[2] / "scripts" / "live_certification_gate.py"
        assert path.is_file(), "live_certification_gate.py missing"

    def test_live_certification_gate_imports_cleanly(self):
        """live_certification_gate.py must import without error."""
        import importlib.util, sys
        from pathlib import Path
        path = Path(__file__).resolve().parents[2] / "scripts" / "live_certification_gate.py"
        spec = importlib.util.spec_from_file_location("live_cert", path)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        assert hasattr(mod, "main")

    def test_predeploy_gate_does_not_call_full_pytest(self):
        """predeploy_release_gate.py must not run pytest without live-marker exclusion."""
        from pathlib import Path
        script = (Path(__file__).resolve().parents[2] / "scripts" / "predeploy_release_gate.py").read_text(encoding="utf-8")
        # Must have the exclusion constant
        assert "PYTEST_EXCLUDE_EXPR" in script
        # Must not have a bare ["-m", "pytest", "-q"] without the exclusion expression
        lines = [
            l for l in script.splitlines()
            if '"-m", "pytest"' in l and "PYTEST_EXCLUDE_EXPR" not in l and not l.strip().startswith("#")
        ]
        assert not lines, f"predeploy gate has bare pytest call without exclusion: {lines}"

    def test_openai_live_tools_blocked(self):
        from app.config import Settings
        s = Settings(OPENAI_API_KEY="test")
        assert s.VOICE_LIVE_DISABLE_OPENAI_TOOLS is True

    def test_payment_safety_guard_unchanged(self):
        from app.payment.safety import require_payment_send_ready
        assert callable(require_payment_send_ready)
