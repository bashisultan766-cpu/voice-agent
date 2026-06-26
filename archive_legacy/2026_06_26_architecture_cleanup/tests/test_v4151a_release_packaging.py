"""v4.15.1a — Release packaging and VPS validation tests."""
from __future__ import annotations

import importlib.util
import io
import os
import sys
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

ROOT = Path(__file__).resolve().parents[2]


def _load_script(name: str):
    path = ROOT / "scripts" / name
    spec = importlib.util.spec_from_file_location(name.replace(".py", ""), path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(autouse=True)
def _clear_caches():
    from app.agent_runtime.prompt_loader import clear_prompt_cache
    from app.agent_runtime.prompt_pack_loader import clear_prompt_pack_cache
    from app.config import get_settings

    clear_prompt_cache()
    clear_prompt_pack_cache()
    get_settings.cache_clear()
    yield
    clear_prompt_cache()
    clear_prompt_pack_cache()
    get_settings.cache_clear()


class TestPromptLoaderVersion:
    def test_v413_prompt_loader_accepts_configured_version(self):
        from app.config import get_settings
        from app.agent_runtime.prompt_loader import (
            get_prompt_load_status,
            load_eric_system_prompt_text,
        )

        load_eric_system_prompt_text()
        status = get_prompt_load_status()
        assert status["version"] == get_settings().ERIC_SYSTEM_PROMPT_VERSION

    def test_prompt_loader_legacy_version_v1(self, monkeypatch):
        monkeypatch.setenv("ERIC_PROMPT_PACK_ENABLED", "false")
        monkeypatch.setenv("ERIC_SYSTEM_PROMPT_VERSION", "v1")
        from app.config import get_settings
        from app.agent_runtime.prompt_loader import (
            clear_prompt_cache,
            get_prompt_load_status,
            load_eric_system_prompt_text,
        )

        get_settings.cache_clear()
        clear_prompt_cache()
        load_eric_system_prompt_text()
        status = get_prompt_load_status()
        assert status["version"] == "v1"

    def test_prompt_loader_prompt_pack_version_v4151(self, monkeypatch):
        monkeypatch.setenv("ERIC_PROMPT_PACK_ENABLED", "true")
        monkeypatch.setenv("ERIC_SYSTEM_PROMPT_VERSION", "v4151")
        from app.config import get_settings
        from app.agent_runtime.prompt_loader import (
            clear_prompt_cache,
            get_prompt_load_status,
            load_eric_system_prompt_text,
        )

        get_settings.cache_clear()
        clear_prompt_cache()
        load_eric_system_prompt_text()
        status = get_prompt_load_status()
        assert status["version"] == "v4151"
        assert status.get("source") == "prompt_pack"
        assert status.get("pack_hash")


class TestReleaseCompleteness:
    def test_detects_missing_required_file(self, tmp_path):
        mod = _load_script("check_release_completeness.py")
        ok, missing = mod.check_release_completeness(tmp_path)
        assert not ok
        assert missing
        assert "app/agent_runtime/prompt_pack_loader.py" in missing

    def test_passes_when_all_required_files_exist(self):
        mod = _load_script("check_release_completeness.py")
        ok, missing = mod.check_release_completeness(ROOT)
        assert ok, missing
        assert missing == []

    def test_main_prints_pass(self, capsys):
        mod = _load_script("check_release_completeness.py")
        assert mod.main() == 0
        out = capsys.readouterr().out
        assert "RELEASE_COMPLETENESS=PASS" in out


class TestPredeployGate:
    def test_gate_fails_if_release_completeness_fails(self):
        gate = _load_script("predeploy_release_gate.py")
        fail_check = gate.GateCheck(
            "Release completeness",
            "scripts/check_release_completeness.py",
            False,
            "missing: scripts/audit_live_tools.py",
        )
        with patch.object(gate, "_check_release_completeness", return_value=fail_check):
            buf = io.StringIO()
            with redirect_stdout(buf):
                # Pass explicit argv so argparse doesn't consume pytest's sys.argv
                code = gate.main([])
        out = buf.getvalue()
        assert code == 1
        assert "RELEASE_GATE=FAIL" in out
        assert "missing" in out.lower()

    def test_gate_openai_tools_blocked(self):
        gate = _load_script("predeploy_release_gate.py")
        assert gate._check_openai_tools_blocked().passed


class TestValidateReleaseBundle:
    def test_stops_on_first_failure(self):
        bundle = _load_script("validate_release_bundle.py")
        calls: list[str] = []

        def fake_run(name: str, cmd: list[str], timeout: int = 300) -> tuple[bool, str]:
            calls.append(name)
            if name == "pytest_deterministic":
                return False, "pytest failed"
            return True, "OK"

        with patch.object(bundle, "run_check", side_effect=fake_run):
            buf = io.StringIO()
            with redirect_stdout(buf):
                # Pass explicit argv so argparse doesn't consume pytest's sys.argv
                code = bundle.main([])
        out = buf.getvalue()
        assert code == 1
        assert "pytest_deterministic" in calls
        assert "RELEASE_BUNDLE_VALIDATION=FAIL at step: pytest_deterministic" in out


class TestCheckAgentRuntime:
    def _run_runtime_check(self, monkeypatch) -> tuple[int, str]:
        from app.config import get_settings
        from app.payment.payment_idempotency import clear_idempotency_store

        monkeypatch.setenv("VOICE_AGENT_RUNTIME_MODE", "main_llm_agent")
        monkeypatch.setenv("VOICE_LIVE_DISABLE_OPENAI_TOOLS", "true")
        monkeypatch.setenv("ERIC_PROMPT_PACK_ENABLED", "true")
        get_settings.cache_clear()
        clear_idempotency_store()
        mod = _load_script("check_agent_runtime.py")
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = mod.main()
        return code, buf.getvalue()

    def test_header_not_stale_v4146(self, monkeypatch):
        code, out = self._run_runtime_check(monkeypatch)
        assert "v4.14.6" not in out
        assert "Agent runtime check: v4.16.0" in out
        assert "Prompt pack enabled:" in out
        assert "Prompt pack files:" in out
        assert "Prompt version:" in out
        assert "OpenAI live tools: blocked" in out
        fail_lines = [ln for ln in out.splitlines() if "FAIL" in ln]
        assert code == 0, fail_lines or out[-800:]

    def test_no_secrets_printed(self, monkeypatch):
        _, out = self._run_runtime_check(monkeypatch)
        assert "sk-" not in out
        assert "shpat_" not in out
        assert "You are Eric" not in out

    def test_openai_live_tools_remain_blocked(self):
        from app.config import get_settings

        assert get_settings().VOICE_LIVE_DISABLE_OPENAI_TOOLS is True
