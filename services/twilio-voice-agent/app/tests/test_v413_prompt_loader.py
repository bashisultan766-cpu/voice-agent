"""v4.13 — Eric prompt file loader tests."""
from __future__ import annotations

import logging
import os
from pathlib import Path

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


@pytest.fixture(autouse=True)
def _clear_prompt_cache():
    from app.agent_runtime.prompt_loader import clear_prompt_cache
    clear_prompt_cache()
    from app.config import get_settings
    get_settings.cache_clear()
    yield
    clear_prompt_cache()
    get_settings.cache_clear()


class TestPromptLoader:
    def test_prompt_file_loads(self):
        from app.agent_runtime.prompt_loader import load_eric_system_prompt_text, get_prompt_load_status
        text = load_eric_system_prompt_text()
        status = get_prompt_load_status()
        assert len(text) > 100
        assert status["loaded_from_file"] is True
        assert status["version"] == "v1"
        assert status["chars"] == len(text)

    def test_missing_prompt_falls_back(self, tmp_path, monkeypatch):
        from app.agent_runtime.prompt_loader import load_eric_system_prompt_text, clear_prompt_cache
        missing = tmp_path / "missing_prompt.md"
        monkeypatch.setenv("ERIC_SYSTEM_PROMPT_PATH", str(missing))
        from app.config import get_settings
        get_settings.cache_clear()
        clear_prompt_cache()
        text = load_eric_system_prompt_text()
        assert "Eric" in text
        assert "SureShot Books" in text

    def test_no_prompt_text_in_logs(self, caplog):
        from app.agent_runtime.prompt_loader import load_eric_system_prompt_text
        from app.agent_runtime.eric_master_policy import build_eric_brain_system_prompt
        caplog.set_level(logging.INFO)
        load_eric_system_prompt_text()
        build_eric_brain_system_prompt()
        for record in caplog.records:
            assert "You are Eric" not in record.getMessage()

    def test_prompt_path_env_works(self, tmp_path, monkeypatch):
        from app.agent_runtime.prompt_loader import load_eric_system_prompt_text, clear_prompt_cache
        custom = tmp_path / "custom.md"
        custom.write_text(
            "Custom Eric prompt for testing SureShot Books. "
            "This line ensures the loaded prompt exceeds the minimum length check.",
            encoding="utf-8",
        )
        monkeypatch.setenv("ERIC_SYSTEM_PROMPT_PATH", str(custom))
        monkeypatch.setenv("ERIC_SYSTEM_PROMPT_VERSION", "v99")
        from app.config import get_settings
        get_settings.cache_clear()
        clear_prompt_cache()
        text = load_eric_system_prompt_text(path=str(custom), version="v99")
        assert "Custom Eric prompt" in text

    def test_final_llm_receives_prompt_content(self):
        from app.agent_runtime.eric_master_policy import build_eric_final_response_system_prompt
        prompt = build_eric_final_response_system_prompt()
        assert "Eric" in prompt
        assert "SureShot Books" in prompt
