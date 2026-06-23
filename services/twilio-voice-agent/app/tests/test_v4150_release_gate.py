"""v4.15.0 — Release gate script tests."""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

os.environ.setdefault("OPENAI_API_KEY", "test-key")

ROOT = Path(__file__).resolve().parents[2]


def _load_gate():
    path = ROOT / "scripts" / "predeploy_release_gate.py"
    spec = importlib.util.spec_from_file_location("predeploy_gate", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


class TestReleaseGate:
    def test_gate_inline_checks(self):
        gate = _load_gate()
        assert gate._check_openai_tools_blocked().passed
        assert gate._check_payment_cert_dry_run().passed
        assert gate._check_idempotency().passed
        assert gate._check_rollback_doc().passed

    def test_gate_fails_if_legacy_enabled(self, monkeypatch):
        monkeypatch.setenv("VOICE_AGENT_RUNTIME_MODE", "legacy_v410")
        from app.config import get_settings
        get_settings.cache_clear()
        gate = _load_gate()
        assert not gate._check_openai_tools_blocked().passed
        monkeypatch.delenv("VOICE_AGENT_RUNTIME_MODE", raising=False)
        get_settings.cache_clear()

    def test_runbook_exists(self):
        path = ROOT / "docs" / "PRODUCTION_RELEASE_RUNBOOK_v4150.md"
        text = path.read_text(encoding="utf-8")
        assert "rollback" in text.lower()
        assert "Do **not** enable OpenAI live tools" in text or "not** enable OpenAI" in text
