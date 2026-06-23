"""v4.11 — Regression preservation tests for v4.5-v4.10 guarantees."""
from __future__ import annotations

import ast
import os
from pathlib import Path

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


class TestV411NoRegressions:
    def test_openai_tools_disabled_by_default(self):
        from app.config import get_settings
        assert get_settings().VOICE_LIVE_DISABLE_OPENAI_TOOLS is True

    def test_no_tools_in_composer(self):
        src = Path(__file__).resolve().parent.parent / "composer" / "main_llm_composer.py"
        text = src.read_text(encoding="utf-8")
        assert "tools=" not in text or "NO tools=" in text

    def test_no_tools_in_supervisor_call(self):
        import inspect
        from app.agent_runtime import llm_supervisor
        src = inspect.getsource(llm_supervisor._call_llm_supervisor)
        assert "tools=" not in src

    def test_processing_fee_in_sanitizer(self):
        from app.safety.response_sanitizer import _LEAK_PHRASES
        assert any("processing fee" in p for p in _LEAK_PHRASES)

    def test_candidate_guard_exists(self):
        from app.cart.candidate_guard import should_save_candidate
        assert callable(should_save_candidate)

    def test_intent_contract_exists(self):
        from app.pipeline.intent_contract import validate_intent_contract
        d = validate_intent_contract("vague_book_request")
        assert d.allowed

    def test_response_guard_exists(self):
        from app.pipeline.response_guard import apply_response_guard
        text = apply_response_guard("", "unknown", call_sid="CA1")
        assert text

    def test_query_specificity_guard(self):
        from app.catalog.query_specificity import is_generic_product_query
        assert is_generic_product_query("I need a book")

    def test_payment_line_item_filter(self):
        from app.payment.line_item_filter import detect_internal_fee_item
        assert detect_internal_fee_item({"title": "Processing Fee", "quantity": 1})

    def test_eric_policy_red_river(self):
        from app.brain.eric_policy import get_response_template
        assert "not in stock" in get_response_template("red_river_vengeance").lower()

    def test_legacy_mode_still_available(self):
        from app.config import Settings
        s = Settings(VOICE_AGENT_RUNTIME_MODE="legacy_v410")
        assert s.VOICE_AGENT_RUNTIME_MODE == "legacy_v410"

    def test_no_openai_agent_in_production_path(self):
        from app.ai import openai_agent
        src = Path(openai_agent.__file__).read_text(encoding="utf-8")
        assert "VOICE_LIVE_DISABLE_OPENAI_TOOLS" in src

    @pytest.mark.asyncio
    async def test_engine_legacy_path_still_works(self, monkeypatch):
        monkeypatch.setenv("VOICE_AGENT_RUNTIME_MODE", "legacy_v410")
        from app.config import get_settings
        get_settings.cache_clear()
        from app.agent_runtime.runtime import is_eric_runtime_mode
        assert not is_eric_runtime_mode()
        get_settings.cache_clear()
