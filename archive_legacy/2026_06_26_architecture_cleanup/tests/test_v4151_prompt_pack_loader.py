"""v4.15.1 — Prompt pack loader tests."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

ROOT = Path(__file__).resolve().parents[2]


class TestPromptPackLoader:
    def test_loads_all_files_in_order(self):
        from app.agent_runtime.prompt_pack_loader import load_prompt_pack, clear_prompt_pack_cache

        clear_prompt_pack_cache()
        snap = load_prompt_pack(force_reload=True)
        assert snap.files_loaded == sorted(snap.files_loaded)
        assert snap.files_loaded[0].startswith("00_")
        assert len(snap.files_loaded) >= 6
        assert snap.prompt_chars > 500
        assert "Eric" in snap.text
        assert "SureShot Books" in snap.text

    def test_hash_stable(self):
        from app.agent_runtime.prompt_pack_loader import load_prompt_pack, clear_prompt_pack_cache

        clear_prompt_pack_cache()
        a = load_prompt_pack(force_reload=True)
        b = load_prompt_pack(force_reload=False)
        assert a.prompt_hash == b.prompt_hash

    def test_missing_required_file_fails(self, tmp_path, monkeypatch):
        from app.config import get_settings
        from app.agent_runtime.prompt_pack_loader import load_prompt_pack, clear_prompt_pack_cache

        incomplete = tmp_path / "incomplete"
        incomplete.mkdir()
        (incomplete / "00_eric_core_identity.md").write_text("# Eric\n", encoding="utf-8")
        monkeypatch.setenv("ERIC_PROMPT_PACK_DIR", str(incomplete))
        monkeypatch.setenv("ERIC_PROMPT_PACK_REQUIRE_ALL", "true")
        get_settings.cache_clear()
        clear_prompt_pack_cache()

        with pytest.raises(FileNotFoundError):
            load_prompt_pack(force_reload=True)

        get_settings.cache_clear()

    def test_prompt_loader_uses_pack_when_enabled(self):
        from app.agent_runtime.prompt_loader import load_eric_system_prompt_text, clear_prompt_cache
        from app.agent_runtime.prompt_pack_loader import load_prompt_pack, clear_prompt_pack_cache

        clear_prompt_cache()
        clear_prompt_pack_cache()
        pack = load_prompt_pack(force_reload=True)
        text = load_eric_system_prompt_text()
        assert pack.prompt_hash
        assert "tool use policy" in text.lower() or "30_tool" in str(pack.files_loaded)
