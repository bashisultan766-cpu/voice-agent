"""
Step 6 — facility CSV policy knowledge system tests.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from app.facility.policy_models import FacilityPolicyRecord, normalize_facility_name
from app.facility.policy_service import (
    check_content_allowed,
    explain_facility_restriction,
    get_policy_source,
    load_policy_records,
    search_facility_policy,
)
from app.orchestrator.planner_agent import _plan_facility_question
from app.orchestrator.response_composer import _deterministic_from_tools
from app.orchestrator.types import SupervisorResult, ToolExecutionResult
from app.state.models import SessionState

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "app" / "data"
INVENTORY = Path(__file__).resolve().parents[4] / "docs" / "FACILITY_CSV_INVENTORY.md"

# Allow importing scripts/ when running tests
_SCRIPTS = ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture(autouse=True)
def _reload_policies():
    load_policy_records(reload=True)
    yield
    load_policy_records(reload=True)


class TestCsvInventory:
    def test_inventory_doc_exists(self):
        assert INVENTORY.exists()
        text = INVENTORY.read_text(encoding="utf-8")
        assert "facility_guidelines.csv" in text
        assert "51" in text or "missing" in text.lower()

    def test_csv_files_discovered(self):
        csvs = list(DATA.rglob("*.csv"))
        assert len(csvs) >= 2

    def test_normalized_json_exists(self):
        path = DATA / "facility_policies_normalized.json"
        assert path.exists()
        payload = json.loads(path.read_text(encoding="utf-8"))
        assert payload.get("facility_count", 0) >= 3


class TestIngestion:
    def test_ingestion_script_runs(self):
        import importlib.util

        script_path = ROOT / "scripts" / "ingest_facility_csv_policies.py"
        spec = importlib.util.spec_from_file_location("ingest_facility_csv_policies", script_path)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        assert module.main() == 0
        payload = json.loads((DATA / "facility_policies_normalized.json").read_text(encoding="utf-8"))
        assert payload["facility_count"] >= 3
        load_policy_records(reload=True)


class TestPolicySearch:
    def test_exact_match_smith(self):
        result = search_facility_policy("Smith State Prison", state="TX")
        assert result["found"] is True
        assert result["confidence"] >= 0.85
        assert result.get("escalation_required") is False

    def test_fuzzy_match_smith_prison(self):
        result = search_facility_policy("Smith Prison")
        assert result["found"] is True
        assert "Smith" in result["facility_name"]

    def test_unknown_facility_escalates(self):
        result = search_facility_policy("Totally Unknown Facility XYZ")
        assert result.get("escalation_required") is True


class TestContentPolicy:
    def test_books_allowed_smith(self):
        result = check_content_allowed("Smith State Prison", "book", state="TX")
        assert result["found"] is True
        assert result["allowed"] is True

    def test_magazines_restricted_smith(self):
        result = check_content_allowed("Smith State Prison", "magazine", state="TX")
        assert result["found"] is True
        assert result["allowed"] is False

    def test_newspapers_allowed_smith(self):
        result = check_content_allowed("Smith State Prison", "newspaper", state="TX")
        assert result["found"] is True
        assert result["allowed"] is True

    def test_magazines_restricted_bayview(self):
        result = check_content_allowed("Bayview Magazine Facility", "magazine", state="CA")
        assert result["allowed"] is False

    def test_newspapers_restricted_bayview(self):
        result = check_content_allowed("Bayview CF", "newspaper", state="CA")
        assert result["allowed"] is False


class TestPolicySourceAndExplanation:
    def test_policy_url_stored(self):
        source = get_policy_source("Smith State Prison", state="TX")
        assert source["found"] is True
        assert source["policy_url"].startswith("https://")

    def test_explanation_includes_source(self):
        result = explain_facility_restriction(
            "Smith State Prison",
            "magazine",
            state="TX",
        )
        assert result.get("escalation_required") is False
        assert "restrict" in result["customer_message"].lower()
        assert result.get("source_file")

    def test_missing_facility_name_asks(self):
        result = explain_facility_restriction("", "book")
        assert result.get("needs_facility_name") is True
        assert result.get("escalation_required") is True

    def test_no_invented_answer_for_unknown(self):
        result = explain_facility_restriction("Unknown Facility ZZZ", "book")
        assert result.get("escalation_required") is True or result.get("found") is False


class TestPlannerAndComposer:
    def test_planner_magazine_question(self):
        session = SessionState(
            session_id="s1", call_sid="CA1", from_number="+1", to_number="+2"
        )
        plan = _plan_facility_question(
            "Does Smith State Prison allow magazines?",
            session,
        )
        assert plan.steps[0].tool == "check_facility_content_allowed"
        assert plan.steps[0].args["content_type"] == "magazine"

    def test_planner_delivery_question_includes_order(self):
        session = SessionState(
            session_id="s1", call_sid="CA1", from_number="+1", to_number="+2"
        )
        plan = _plan_facility_question(
            "Order 12345 book was not delivered to Smith State Prison",
            session,
        )
        assert plan.steps[0].tool == "explain_facility_delivery_rejection"
        assert plan.steps[0].args["order_number"] == "12345"

    def test_composer_uses_facility_customer_message(self):
        msg = _deterministic_from_tools(
            [
                ToolExecutionResult(
                    tool="check_facility_content_allowed",
                    success=True,
                    result={
                        "customer_message": "Magazines are restricted at Smith State Prison.",
                        "escalation_required": False,
                    },
                ),
            ],
            SupervisorResult(intent="facility_question"),
        )
        assert "restricted" in msg.lower()


class TestNormalizedModel:
    def test_normalize_facility_name(self):
        assert normalize_facility_name("Smith State Prison") == "smithstateprison"

    def test_record_roundtrip(self):
        rec = FacilityPolicyRecord(
            facility_name="Test",
            allowed_books=True,
            policy_url="https://example.com",
        )
        restored = FacilityPolicyRecord.from_dict(rec.to_dict())
        assert restored.facility_name == "Test"
        assert restored.allowed_books is True
