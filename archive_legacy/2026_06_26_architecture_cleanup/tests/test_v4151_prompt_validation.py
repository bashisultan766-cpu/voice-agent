"""v4.15.1 — Prompt validation script tests."""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

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


class TestPromptValidation:
    def test_validate_eric_prompt_passes(self):
        mod = _load_script("validate_eric_prompt.py")
        results = mod.validate()
        fails = [r for r in results if r.startswith("FAIL")]
        assert not fails, fails

    def test_print_prompt_pack_summary_masks_secrets(self, capsys):
        mod = _load_script("print_prompt_pack_summary.py")
        rc = mod.main()
        out = capsys.readouterr().out
        assert rc == 0
        assert "Hash:" in out
        assert "No secrets found: True" in out
        assert "sk-" not in out

    def test_prompt_pack_includes_greeting_examples(self):
        from app.agent_runtime.prompt_pack_loader import load_prompt_pack

        snap = load_prompt_pack(force_reload=True)
        lower = snap.text.lower()
        assert "how are you" in lower
        assert "remember" in lower
        assert "newspaper" in lower
