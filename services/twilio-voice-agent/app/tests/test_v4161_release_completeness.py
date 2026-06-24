"""v4.16.1 — Release completeness tests."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

ROOT = Path(__file__).resolve().parents[2]


class TestReleaseCompleteness:
    def test_all_required_files_present(self):
        import importlib.util, sys
        path = ROOT / "scripts" / "check_release_completeness.py"
        spec = importlib.util.spec_from_file_location("check_rc", path)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        sys.modules["check_rc"] = mod
        spec.loader.exec_module(mod)
        ok, missing = mod.check_release_completeness(ROOT)
        assert ok, f"Release completeness FAIL — missing {len(missing)} file(s): {missing}"

    def test_v4160_brain_files_present(self):
        required = [
            "app/agent_runtime/brain_orchestrator.py",
            "app/agent_runtime/speculative_prefetch_manager.py",
            "app/agent_runtime/brain_prefetch_arbitrator.py",
            "app/agent_runtime/tool_plan_executor.py",
            "app/agent_runtime/domain_boundary.py",
        ]
        for rel in required:
            assert (ROOT / rel).is_file(), f"Missing v4.16.0 file: {rel}"

    def test_v4160_scouts_present(self):
        scouts = [
            "conversation_scout", "catalog_scout", "isbn_scout",
            "publication_scout", "order_scout", "refund_scout",
            "facility_scout", "cart_scout", "payment_readiness_scout",
            "email_scout", "domain_scout",
        ]
        for scout in scouts:
            path = ROOT / "app" / "agent_runtime" / "scouts" / f"{scout}.py"
            assert path.is_file(), f"Missing scout: {scout}.py"

    def test_v4161_release_gate_files_present(self):
        required = [
            "scripts/live_certification_gate.py",
            "scripts/verify_catalog_index_ready.py",
            "scripts/verify_brain_smoke_call.py",
        ]
        for rel in required:
            assert (ROOT / rel).is_file(), f"Missing v4.16.1 file: {rel}"

    def test_openai_tools_remain_blocked(self):
        from app.config import Settings
        s = Settings(OPENAI_API_KEY="test")
        assert s.VOICE_LIVE_DISABLE_OPENAI_TOOLS is True

    def test_payment_safety_guard_present(self):
        from app.payment.safety import require_payment_send_ready
        assert callable(require_payment_send_ready)

    def test_openai_live_tools_disabled_at_runtime(self):
        """Runtime guard: live OpenAI tools must remain disabled in config defaults."""
        from app.config import Settings
        # Default settings (test key) must have live tools blocked
        s = Settings(OPENAI_API_KEY="test")
        assert s.VOICE_LIVE_DISABLE_OPENAI_TOOLS is True, (
            "VOICE_LIVE_DISABLE_OPENAI_TOOLS must default to True to block live OpenAI tools"
        )
        # Agent runtime mode must not be legacy
        assert s.VOICE_AGENT_RUNTIME_MODE != "legacy_v410"
