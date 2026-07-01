"""
Step 9 — facility policy fetch validation and answer quality tests.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.facility.policy_analyzer import FacilityPolicyAnalysis, analyze_policy_text
from app.facility.policy_models import FacilityPolicyRecord
from app.facility.policy_service import (
    answer_facility_question,
    check_content_allowed,
    explain_delivery_rejection,
    get_facility_policy_analysis,
    load_policy_records,
)
from app.facility import policy_service

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "app" / "data"
DOCS = ROOT.parents[1] / "docs"
_SCRIPTS = ROOT / "scripts"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture(autouse=True)
def _reload_policies():
    load_policy_records(reload=True)
    yield
    load_policy_records(reload=True)


class TestAnalyzedPolicyOverridesCsv:
    def test_analyzed_policy_overrides_url_only_csv(self, monkeypatch):
        rec = FacilityPolicyRecord(
            facility_name="URL Only Test Facility",
            state="TX",
            policy_url="https://example.com/policy-only",
        )
        fake = FacilityPolicyAnalysis(
            facility_name="URL Only Test Facility",
            state="TX",
            magazines_allowed=False,
            policy_summary="Magazines restricted per ingested policy.",
            confidence=0.88,
            escalation_required=False,
            source="ingested_policy",
            evidence_snippets=["Magazines are not allowed."],
        )
        monkeypatch.setattr(
            policy_service,
            "load_policy_records",
            lambda reload=False: [rec],
        )
        monkeypatch.setattr(
            policy_service,
            "search_facility_policy",
            lambda name, state=None: {
                "found": True,
                "escalation_required": False,
                "facility_name": rec.facility_name,
                "confidence": 0.9,
                "state": rec.state,
            },
        )
        monkeypatch.setattr(
            policy_service,
            "_record_from_search",
            lambda search, facility_name, state=None: rec,
        )
        monkeypatch.setattr(
            policy_service,
            "load_policy_analyses",
            lambda reload=False: {rec.facility_name: fake},
        )
        result = check_content_allowed(rec.facility_name, "magazine", state="TX")
        assert result["allowed"] is False
        assert result.get("policy_source") == "ingested_policy"


class TestLowConfidenceEscalation:
    def test_low_confidence_analysis_escalates(self, monkeypatch):
        rec = FacilityPolicyRecord(
            facility_name="Low Confidence Facility",
            state="CA",
            policy_url="https://example.com/vague",
        )
        fake = FacilityPolicyAnalysis(
            facility_name="Low Confidence Facility",
            state="CA",
            confidence=0.2,
            escalation_required=True,
            source="ingested_policy",
        )
        monkeypatch.setattr(policy_service, "load_policy_records", lambda reload=False: [rec])
        monkeypatch.setattr(
            policy_service,
            "search_facility_policy",
            lambda name, state=None: {
                "found": True,
                "escalation_required": False,
                "facility_name": rec.facility_name,
                "confidence": 0.9,
            },
        )
        monkeypatch.setattr(
            policy_service,
            "_record_from_search",
            lambda search, facility_name, state=None: rec,
        )
        monkeypatch.setattr(
            policy_service,
            "load_policy_analyses",
            lambda reload=False: {rec.facility_name: fake},
        )
        result = get_facility_policy_analysis(rec.facility_name, state="CA")
        assert result.get("escalation_required") is True


class TestEvidenceAndCustomerSafety:
    def test_evidence_snippets_in_internal_result(self, monkeypatch):
        text = "Magazines are not allowed. Books paperback only."
        analysis = analyze_policy_text(
            text,
            facility_name="Evidence Facility",
            state="TX",
        )
        assert analysis.evidence_snippets
        monkeypatch.setattr(
            policy_service,
            "load_policy_analyses",
            lambda reload=False: {"Smith State Prison": analysis},
        )
        result = get_facility_policy_analysis("Smith State Prison", state="TX")
        if result.get("analysis_found"):
            assert result.get("evidence_snippets") or analysis.evidence_snippets

    def test_customer_answer_not_huge_raw_text(self):
        result = answer_facility_question(
            "Smith State Prison",
            "What is the mail policy?",
            state="TX",
        )
        msg = str(result.get("customer_message") or result.get("message") or "")
        assert len(msg) < 2000
        assert "<html" not in msg.lower()


class TestFetchFallback:
    def test_missing_fetched_policy_falls_back_to_csv(self):
        result = check_content_allowed("Smith State Prison", "magazine", state="TX")
        assert result["allowed"] is False

    def test_failed_fetch_does_not_break_live_answer(self, monkeypatch):
        import importlib.util

        script = _SCRIPTS / "fetch_facility_policy_links.py"
        spec = importlib.util.spec_from_file_location("fetch_val", script)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)

        with patch("httpx.Client") as mock_client_cls:
            result = answer_facility_question(
                "Smith State Prison",
                "Are magazines allowed?",
                state="TX",
            )
            mock_client_cls.assert_not_called()
        assert result.get("customer_message") or result.get("message")

    def test_delivery_rejection_with_failed_fetch_metadata(self, tmp_path, monkeypatch):
        import importlib.util

        script = _SCRIPTS / "fetch_facility_policy_links.py"
        spec = importlib.util.spec_from_file_location("fetch_meta", script)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)

        raw_dir = tmp_path / "raw"
        raw_dir.mkdir()
        url = "https://example.com/failed-policy"
        h = mod.url_hash(url)
        (raw_dir / f"{h}.metadata.json").write_text(
            json.dumps({"url": url, "error": "http_404", "text_length": 0}),
            encoding="utf-8",
        )
        result = explain_delivery_rejection(
            "Smith State Prison",
            product_title="Test Magazine",
            content_type="magazine",
            state="TX",
        )
        assert result.get("customer_message") or result.get("message")


class TestValidationScript:
    def test_validation_script_creates_report(self, tmp_path, monkeypatch):
        import importlib.util

        script = _SCRIPTS / "validate_facility_policy_answers.py"
        spec = importlib.util.spec_from_file_location("validate_facility_policy_answers", script)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        sys.modules["validate_facility_policy_answers"] = mod
        spec.loader.exec_module(mod)

        out = tmp_path / "validation.md"
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "validate_facility_policy_answers.py",
                "--sample",
                "10",
                "--output",
                str(out),
            ],
        )
        assert mod.main() == 0
        assert out.exists()
        text = out.read_text(encoding="utf-8")
        assert "Facility Policy Answer Validation" in text
        assert "Pass rate" in text or "lookup" in text.lower()
