"""v4.15.0 — Production runbook content tests."""
from __future__ import annotations

import os
from pathlib import Path

os.environ.setdefault("OPENAI_API_KEY", "test-key")

ROOT = Path(__file__).resolve().parents[2]
RUNBOOK = ROOT / "docs" / "PRODUCTION_RELEASE_RUNBOOK_v4150.md"


class TestRunbook:
    def test_runbook_contains_rollback_instructions(self):
        text = RUNBOOK.read_text(encoding="utf-8")
        assert "Rollback" in text or "rollback" in text
        assert "symlink" in text
        assert "pm2" in text.lower()

    def test_runbook_contains_bad_markers(self):
        text = RUNBOOK.read_text(encoding="utf-8")
        assert "legacy_v410" in text
        assert "Processing Fee" in text
        assert "payment_link_email_sent" in text

    def test_runbook_contains_certification_flags(self):
        text = RUNBOOK.read_text(encoding="utf-8")
        assert "VOICE_PAYMENT_CERTIFICATION_MODE" in text
        assert "VOICE_PAYMENT_CERTIFICATION_TEST_EMAILS" in text

    def test_no_openai_live_tools_in_runbook(self):
        text = RUNBOOK.read_text(encoding="utf-8")
        assert "VOICE_LIVE_DISABLE_OPENAI_TOOLS" in text
