"""
Step 8 — facility policy link offline ingestion and live cached answers.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.facility.policy_analyzer import (
    FacilityPolicyAnalysis,
    analyze_policy_text,
    url_hash,
)
from app.facility.policy_link_inventory import audit_policy_links
from app.facility.policy_models import FacilityPolicyRecord
from app.facility.policy_service import (
    answer_facility_question,
    explain_delivery_rejection,
    get_facility_policy_analysis,
    load_policy_records,
)
from app.facility.product_content_classifier import classify_product_content
from app.orchestrator.planner_agent import _plan_facility_question
from app.orchestrator.response_composer import _deterministic_from_tools
from app.orchestrator.types import SupervisorResult, ToolExecutionResult
from app.state.models import SessionState

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


class TestPolicyLinkInventory:
    def test_inventory_counts_urls(self):
        inv = audit_policy_links(
            data_path=DATA / "facility_policies_normalized.json",
        )
        assert inv.total_facilities >= 3
        assert inv.facilities_with_policy_url >= 1
        assert inv.unique_policy_urls >= 1

    def test_inventory_doc_exists(self, monkeypatch):
        script = _SCRIPTS / "generate_facility_policy_link_inventory.py"
        import importlib.util

        spec = importlib.util.spec_from_file_location("gen_inv", script)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        monkeypatch.setattr(sys, "argv", ["generate_facility_policy_link_inventory.py"])
        assert mod.main() == 0
        assert (DOCS / "FACILITY_POLICY_LINK_INVENTORY.md").exists()


class TestPolicyFetcher:
    def test_fetcher_caches_raw_policy_text(self, tmp_path, monkeypatch):
        import importlib.util

        script = _SCRIPTS / "fetch_facility_policy_links.py"
        spec = importlib.util.spec_from_file_location("fetch_pol", script)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)

        raw_dir = tmp_path / "raw"
        raw_dir.mkdir()
        monkeypatch.setattr(mod, "_RAW_DIR", raw_dir)

        html = "<html><body><p>Magazines are not allowed. Books paperback only.</p></body></html>"
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"content-type": "text/html"}
        mock_resp.text = html
        mock_resp.content = html.encode()

        mock_client = MagicMock()
        mock_client.get.return_value = mock_resp
        monkeypatch.setattr(mod, "_robots_allowed", lambda url, client: True)

        url = "https://example.com/test-policy"
        meta = mod.fetch_policy_url(url, client=mock_client, force=True)
        h = url_hash(url)
        assert (raw_dir / f"{h}.txt").exists()
        assert meta.get("text_length", 0) > 0

    def test_fetcher_skips_existing_cache(self, tmp_path, monkeypatch):
        import importlib.util

        script = _SCRIPTS / "fetch_facility_policy_links.py"
        spec = importlib.util.spec_from_file_location("fetch_pol2", script)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)

        raw_dir = tmp_path / "raw"
        raw_dir.mkdir()
        monkeypatch.setattr(mod, "_RAW_DIR", raw_dir)
        url = "https://example.com/cached-policy"
        h = url_hash(url)
        (raw_dir / f"{h}.txt").write_text("cached policy text", encoding="utf-8")
        (raw_dir / f"{h}.metadata.json").write_text(
            json.dumps({"url": url, "status": "200", "text_length": 10}),
            encoding="utf-8",
        )
        mock_client = MagicMock()
        meta = mod.fetch_policy_url(url, client=mock_client, force=False)
        assert meta.get("skipped") is True
        mock_client.get.assert_not_called()

    def test_html_policy_text_extraction(self):
        import importlib.util

        script = _SCRIPTS / "fetch_facility_policy_links.py"
        spec = importlib.util.spec_from_file_location("fetch_pol3", script)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)

        html = "<html><body><p>Books are allowed. No magazines permitted.</p></body></html>"
        text = mod._extract_html_text(html)
        assert "magazines" in text.lower()

    def test_pdf_unsupported_path_does_not_crash(self, monkeypatch):
        import importlib.util

        script = _SCRIPTS / "fetch_facility_policy_links.py"
        spec = importlib.util.spec_from_file_location("fetch_pol4", script)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)

        monkeypatch.setattr(mod, "_pdf_supported", lambda: False)
        text, err = mod._extract_pdf_text(b"%PDF-1.4 fake")
        assert text == ""
        assert err and "unsupported" in err.lower()


class TestPolicyAnalyzer:
    def test_detects_books_allowed(self):
        text = "Paperback books are allowed. Ship direct from publisher."
        analysis = analyze_policy_text(
            text,
            facility_name="Test Facility",
            state="TX",
            policy_url="https://example.com/policy",
        )
        assert analysis.books_allowed is True

    def test_detects_magazines_restricted(self):
        text = "Magazines are not allowed at this facility. Books paperback only."
        analysis = analyze_policy_text(text, facility_name="Test", state="CA")
        assert analysis.magazines_allowed is False

    def test_detects_vendor_required(self):
        text = "All books must ship direct from publisher or approved vendor."
        analysis = analyze_policy_text(text, facility_name="Test", state="TX")
        assert analysis.vendor_required is True

    def test_evidence_snippets_stored(self):
        text = "No magazines or periodicals are permitted."
        analysis = analyze_policy_text(text, facility_name="Test", state="TX")
        assert analysis.evidence_snippets
        assert len(analysis.evidence_snippets[0]) <= 200


class TestPolicyServiceIntegration:
    def test_uses_policy_analysis_before_csv(self, monkeypatch):
        from app.facility import policy_service

        fake = FacilityPolicyAnalysis(
            facility_name="Smith State Prison",
            state="TX",
            magazines_allowed=False,
            policy_summary="Ingested: magazines restricted.",
            confidence=0.9,
            escalation_required=False,
            source="ingested_policy",
        )
        monkeypatch.setattr(
            policy_service,
            "load_policy_analyses",
            lambda reload=False: {"Smith State Prison": fake},
        )
        result = policy_service.check_content_allowed("Smith State Prison", "magazine", state="TX")
        assert result["allowed"] is False
        assert result.get("policy_source") == "ingested_policy"

    def test_uses_csv_when_no_ingested_analysis(self):
        from app.facility.policy_service import check_content_allowed

        result = check_content_allowed("Smith State Prison", "magazine", state="TX")
        assert result["allowed"] is False

    def test_missing_policy_link_falls_back_to_csv(self):
        result = get_facility_policy_analysis("Smith State Prison", state="TX")
        assert result.get("analysis_found") or result.get("found")

    def test_unknown_policy_escalates(self):
        result = answer_facility_question("Totally Unknown Facility ZZZ", "What is the mail policy?")
        assert result.get("escalation_required") is True
        assert "forward" in (result.get("message") or result.get("customer_message", "")).lower()

    def test_delivery_rejection_requires_policy_evidence(self):
        result = explain_delivery_rejection(
            "Smith State Prison",
            product_title="National Geographic Magazine",
            content_type="magazine",
            state="TX",
        )
        assert result.get("policy_evidence") is True
        assert "restrict" in result["customer_message"].lower()


class TestProductContentClassifier:
    def test_detects_magazine(self):
        c = classify_product_content(product_title="People Magazine Annual")
        assert c.content_type == "magazine"

    def test_detects_newspaper(self):
        c = classify_product_content(product_title="Wall Street Journal Subscription")
        assert c.content_type == "newspaper"


class TestPlannerAndComposer:
    def test_planner_routes_delivery_rejection(self):
        session = SessionState(session_id="s1", call_sid="CA1", from_number="+1", to_number="+2")
        plan = _plan_facility_question(
            "Order 12345 book was not delivered to Smith State Prison",
            session,
        )
        assert plan.steps[0].tool == "explain_facility_delivery_rejection"
        assert plan.steps[0].args["order_number"] == "12345"

    def test_composer_customer_friendly_answer(self):
        msg = _deterministic_from_tools(
            [
                ToolExecutionResult(
                    tool="explain_facility_delivery_rejection",
                    success=True,
                    result={
                        "customer_message": (
                            "Based on the facility policy information I have, that facility "
                            "appears to restrict magazine."
                        ),
                        "escalation_required": False,
                    },
                ),
            ],
            SupervisorResult(intent="facility_question"),
        )
        assert "facility policy" in msg.lower()

    def test_live_path_does_not_fetch_external_urls(self):
        import importlib.util

        script = _SCRIPTS / "fetch_facility_policy_links.py"
        spec = importlib.util.spec_from_file_location("fetch_live", script)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)

        with patch("httpx.Client") as mock_client_cls:
            from app.facility.policy_service import search_facility_policy

            search_facility_policy("Smith State Prison", state="TX")
            mock_client_cls.assert_not_called()


class TestOrderPrivacy:
    @pytest.mark.asyncio
    async def test_order_verification_required(self):
        from app.agent_runtime import llm_tools

        session = SessionState(session_id="s1", call_sid="CA1", from_number="+1", to_number="+2")
        with patch.object(
            llm_tools._st,
            "lookup_order",
            return_value=json.dumps({
                "verification_required": True,
                "message": "Please confirm your email.",
            }),
        ):
            raw = await llm_tools._explain_facility_delivery_rejection(
                llm_tools.ExplainFacilityDeliveryRejectionArgs(
                    facility_name="Smith State Prison",
                    order_number="12345",
                ),
                session,
            )
        payload = json.loads(raw)
        assert payload.get("verification_required") is True


class TestAnalyzeScript:
    def test_analyze_script_writes_outputs(self):
        import importlib.util

        script = _SCRIPTS / "analyze_facility_policies.py"
        spec = importlib.util.spec_from_file_location("analyze", script)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        stats = mod.run_analyze(limit=5)
        assert stats["total"] == 5
        # Restore full analysis artifact after limit smoke test
        mod.run_analyze(limit=0)
