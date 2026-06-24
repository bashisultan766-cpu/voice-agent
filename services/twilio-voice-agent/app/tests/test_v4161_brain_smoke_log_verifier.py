"""v4.16.1 — Brain smoke call verifier tests."""
from __future__ import annotations

import io
import os
from contextlib import redirect_stdout
from pathlib import Path

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


def _load_verifier():
    import importlib.util, sys
    path = Path(__file__).resolve().parents[2] / "scripts" / "verify_brain_smoke_call.py"
    spec = importlib.util.spec_from_file_location("verify_brain_smoke", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["verify_brain_smoke"] = mod
    spec.loader.exec_module(mod)
    return mod


class TestBrainSmokeLogVerifier:
    def test_hello_presence_scenario_passes(self):
        mod = _load_verifier()
        scenario = next(s for s in mod.SCENARIOS if s.name == "hello_presence")
        ok, detail = mod._run_brain_scenario(scenario)
        assert ok, f"hello_presence failed: {detail}"

    def test_greeting_brother_scenario_passes(self):
        mod = _load_verifier()
        scenario = next(s for s in mod.SCENARIOS if s.name == "greeting_brother")
        ok, detail = mod._run_brain_scenario(scenario)
        assert ok, f"greeting_brother failed: {detail}"

    def test_identity_yes_or_no_passes(self):
        mod = _load_verifier()
        scenario = next(s for s in mod.SCENARIOS if s.name == "identity_yes_or_no")
        ok, detail = mod._run_brain_scenario(scenario)
        assert ok, f"identity_yes_or_no failed: {detail}"

    def test_meta_complaint_no_architecture_leak(self):
        mod = _load_verifier()
        scenario = next(s for s in mod.SCENARIOS if s.name == "meta_complaint")
        ok, detail = mod._run_brain_scenario(scenario)
        assert ok, f"meta_complaint leaked architecture: {detail}"

    def test_tea_recipe_redirects_not_recipe(self):
        mod = _load_verifier()
        scenario = next(s for s in mod.SCENARIOS if s.name == "tea_recipe_out_of_domain")
        ok, detail = mod._run_brain_scenario(scenario)
        assert ok, f"tea_recipe did not redirect: {detail}"

    def test_cricket_books_creates_catalog_plan(self):
        mod = _load_verifier()
        scenario = next(s for s in mod.SCENARIOS if s.name == "cricket_books_catalog")
        ok, detail = mod._run_brain_scenario(scenario)
        assert ok, f"cricket_books_catalog failed: {detail}"

    def test_usa_today_creates_catalog_plan(self):
        mod = _load_verifier()
        scenario = next(s for s in mod.SCENARIOS if s.name == "usa_today_catalog")
        ok, detail = mod._run_brain_scenario(scenario)
        assert ok, f"usa_today_catalog failed: {detail}"

    def test_payment_empty_cart_asks_item(self):
        mod = _load_verifier()
        scenario = next(s for s in mod.SCENARIOS if s.name == "payment_link_empty_cart")
        ok, detail = mod._run_brain_scenario(scenario)
        assert ok, f"payment_empty_cart failed: {detail}"

    def test_simulate_pass_flag_exits_zero(self):
        mod = _load_verifier()
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = mod.main(["--simulate-pass"])
        output = buf.getvalue()
        assert code == 0, f"simulate-pass failed: {output}"
        assert "BRAIN_SMOKE_CALL=PASS" in output

    def test_bad_markers_detected_in_log(self, tmp_path: Path):
        mod = _load_verifier()
        log = tmp_path / "bad.log"
        log.write_text("2026-01-01 CAlive1 mixed_identifiers_detected text=hello brother\n")
        result = mod._check_log_file(log, "CAlive1")
        assert "mixed_identifiers_detected" in result.bad_found

    def test_good_markers_detected_in_log(self, tmp_path: Path):
        mod = _load_verifier()
        log = tmp_path / "good.log"
        log.write_text(
            "2026-01-01 CAlive1 brain_decision_started sid=CAlive1\n"
            "2026-01-01 CAlive1 brain_decision_complete sid=CAlive1 mode=direct_answer\n"
            "2026-01-01 CAlive1 speculative_prefetch_started sid=CAlive1\n"
            "2026-01-01 CAlive1 speculative_prefetch_completed sid=CAlive1 results=3\n"
            "2026-01-01 CAlive1 brain_prefetch_review_completed accepted=1\n"
        )
        result = mod._check_log_file(log, "CAlive1")
        assert not result.bad_found
        assert "brain_decision_started" in result.good_found
