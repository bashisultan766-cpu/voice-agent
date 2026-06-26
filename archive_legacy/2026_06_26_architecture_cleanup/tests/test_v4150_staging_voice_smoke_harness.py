"""v4.15.0 — Staging smoke harness tests."""
from __future__ import annotations

import importlib.util
import io
import os
from contextlib import redirect_stdout
from pathlib import Path

os.environ.setdefault("OPENAI_API_KEY", "test-key")

ROOT = Path(__file__).resolve().parents[2]


def _run_script(name: str) -> tuple[int, str]:
    path = ROOT / "scripts" / name
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod  # type: ignore[name-defined]
    spec.loader.exec_module(mod)
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = mod.main()
    return code, buf.getvalue()


import sys  # noqa: E402


class TestStagingSmokeHarness:
    def test_smoke_plan_markers(self):
        code, out = _run_script("run_staging_voice_smoke_plan.py")
        assert code == 0
        assert "MARKER: staging_smoke_plan_v4150_complete" in out
        assert "[A]" in out and "[Q]" in out
        assert "Duplicate blocked" in out or "[N]" in out

    def test_log_verifier_detects_bad_markers(self):
        path = ROOT / "scripts" / "verify_staging_voice_logs.py"
        spec = importlib.util.spec_from_file_location("verify_logs_mod", path)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)

        bad_log = "legacy_v410 tool_calls Processing Fee https://checkout.shopify.com/pay/abc"
        result = mod.verify_logs(bad_log, sid="CA123")
        assert not result["pass"]
        assert result["found_bad"] or result["pattern_hits"]

    def test_log_verifier_detects_sent_without_email_marker(self):
        path = ROOT / "scripts" / "verify_staging_voice_logs.py"
        spec = importlib.util.spec_from_file_location("verify_logs_mod2", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        log = "I sent the payment link to the customer"
        result = mod.verify_logs(log)
        assert "sent_without_payment_link_email_sent" in result["found_bad"] or not result["pass"]

    def test_log_verifier_passes_clean_log(self):
        path = ROOT / "scripts" / "verify_staging_voice_logs.py"
        spec = importlib.util.spec_from_file_location("verify_logs_mod3", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        log = "payment_link_email_sent masked_email=a***@gmail.com commerce_cart_line_added"
        result = mod.verify_logs(log)
        assert not result["found_bad"]
