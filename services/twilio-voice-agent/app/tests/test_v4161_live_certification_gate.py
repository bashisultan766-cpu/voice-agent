"""v4.16.1 — Live certification gate tests."""
from __future__ import annotations

import io
import os
from contextlib import redirect_stdout

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


def _load_gate():
    import importlib.util, sys
    from pathlib import Path
    path = Path(__file__).resolve().parents[2] / "scripts" / "live_certification_gate.py"
    spec = importlib.util.spec_from_file_location("live_cert_gate", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["live_cert_gate"] = mod
    spec.loader.exec_module(mod)
    return mod


class TestLiveCertificationGate:
    def test_gate_module_importable(self):
        mod = _load_gate()
        assert callable(getattr(mod, "main", None))

    def test_missing_shopify_credentials_returns_skipped(self, monkeypatch):
        """Missing credentials must produce SKIPPED, not a crash."""
        from app.config import Settings
        test_settings = Settings(
            OPENAI_API_KEY="test-key",
            SHOPIFY_SHOP_DOMAIN="",
            SHOPIFY_ADMIN_ACCESS_TOKEN="",
        )
        mod = _load_gate()
        monkeypatch.setattr("app.config.get_settings", lambda: test_settings)

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = mod.main(["--shopify"])
        output = buf.getvalue()
        assert code == 0, f"Expected exit 0 for skipped, got {code}"
        assert "SKIPPED" in output or "missing_credentials" in output

    def test_missing_resend_credentials_returns_skipped(self, monkeypatch):
        from app.config import Settings
        test_settings = Settings(OPENAI_API_KEY="test-key", RESEND_API_KEY="")
        mod = _load_gate()
        monkeypatch.setattr("app.config.get_settings", lambda: test_settings)

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = mod.main(["--resend"])
        output = buf.getvalue()
        assert code == 0
        assert "SKIPPED" in output or "missing" in output.lower()

    def test_live_certification_not_run_by_default_pytest(self):
        """Verify that the predeploy gate uses exclusion filter, not full pytest suite.
        This is a static analysis guard — we do not spawn a subprocess to avoid
        Windows handle restrictions in CI.
        """
        from pathlib import Path
        gate_script = (Path(__file__).resolve().parents[2] / "scripts" / "predeploy_release_gate.py").read_text(encoding="utf-8")
        assert "not shopify_live" in gate_script, "predeploy gate must exclude shopify_live"
        assert "PYTEST_EXCLUDE_EXPR" in gate_script, "predeploy gate must use PYTEST_EXCLUDE_EXPR"

    def test_live_gate_has_shopify_block(self):
        from pathlib import Path
        script = (Path(__file__).resolve().parents[2] / "scripts" / "live_certification_gate.py").read_text(encoding="utf-8")
        assert "shopify_live" in script
        assert "_credentials_present" in script
        assert "LIVE_CERTIFICATION" in script
