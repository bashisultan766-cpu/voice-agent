"""
Step 7 — facility CSV column mapping, normalization, and service coverage tests.
"""
from __future__ import annotations

import csv
import json
import sys
import tempfile
from pathlib import Path

import pytest

from app.facility.policy_models import FacilityPolicyRecord
from app.facility.policy_service import (
    check_content_allowed,
    load_policy_records,
    search_facility_policy,
)

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "app" / "data"
_SCRIPTS = ROOT / "scripts"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from scripts.ingest_facility_csv_policies import (  # noqa: E402
    _build_policy_summary,
    _map_row,
    _parse_allowance,
    _row_to_record,
    audit_csv_columns,
    discover_csv_files,
    main as ingest_main,
)


@pytest.fixture(autouse=True)
def _reload_policies():
    load_policy_records(reload=True)
    yield
    load_policy_records(reload=True)


class TestRealColumnMapping:
    def test_books_allowed_column_maps(self):
        mapped = _map_row({"Facility Name": "Test Prison", "Books Allowed": "yes"})
        rec = _row_to_record(mapped, source_file="test.csv", source_row=2)
        assert rec is not None
        assert rec.allowed_books is True

    def test_magazines_allowed_column_maps(self):
        mapped = _map_row({"Facility Name": "Test Prison", "Magazines Allowed": "no"})
        rec = _row_to_record(mapped, source_file="test.csv", source_row=2)
        assert rec is not None
        assert rec.allowed_magazines is False

    def test_newspapers_allowed_column_maps(self):
        mapped = _map_row({"Facility Name": "Test Prison", "Newspapers Allowed": "allowed"})
        rec = _row_to_record(mapped, source_file="test.csv", source_row=2)
        assert rec is not None
        assert rec.allowed_newspapers is True

    def test_facility_mail_policy_link_maps_to_policy_url(self):
        mapped = _map_row(
            {
                "Facility Name": "Test Prison",
                "Facility Mail Policy Link": "https://example.com/policy.pdf",
                "Website URL": "https://example.com/home",
            }
        )
        rec = _row_to_record(mapped, source_file="test.csv", source_row=2)
        assert rec is not None
        assert rec.policy_url == "https://example.com/policy.pdf"


class TestValueNormalization:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("yes", True),
            ("no", False),
            ("allowed", True),
            ("prohibited", False),
            ("not allowed", False),
            ("permitted", True),
            ("restricted", False),
            ("depends", None),
            ("see policy", None),
            ("unknown", None),
            ("", None),
        ],
    )
    def test_allowance_values_normalize(self, raw: str, expected: bool | None):
        assert _parse_allowance(raw).value == expected

    def test_blank_values_become_null(self):
        mapped = _map_row(
            {
                "Facility Name": "Blank Policy Facility",
                "Books Allowed": "",
                "Magazines Allowed": " ",
            }
        )
        rec = _row_to_record(mapped, source_file="test.csv", source_row=2)
        assert rec is not None
        assert rec.allowed_books is None
        assert rec.allowed_magazines is None

    def test_policy_summary_includes_restrictions(self):
        record = FacilityPolicyRecord(
            facility_name="R Unit",
            allowed_books=True,
            restricted_content=["no hardcover", "cash not accepted"],
            policy_url="https://example.com/policy",
        )
        summary = _build_policy_summary(record, ["Must ship direct from publisher"])
        assert "Books allowed" in summary
        assert "Restrictions" in summary
        assert "Must ship direct" in summary
        assert "https://example.com/policy" in summary


class TestFacilityServiceAnswers:
    def test_service_books_allowed(self):
        result = check_content_allowed("Smith State Prison", "book", state="TX")
        assert result["found"] is True
        assert result["allowed"] is True
        assert result.get("escalation_required") is False

    def test_service_magazine_restricted(self):
        result = check_content_allowed("Smith State Prison", "magazine", state="TX")
        assert result["found"] is True
        assert result["allowed"] is False

    def test_service_newspaper_restricted_bayview(self):
        result = check_content_allowed("Bayview Magazine Facility", "newspaper", state="CA")
        assert result["found"] is True
        assert result["allowed"] is False

    def test_unclear_value_triggers_escalation(self, monkeypatch):
        unclear = FacilityPolicyRecord(
            facility_name="Depends Policy Jail",
            normalized_facility_name="dependspolicyjail",
            state="ZZ",
            allowed_books=None,
            confidence=0.45,
            policy_summary="Books policy unclear: depends.",
        )

        def _fake_load(*, reload: bool = False):
            return [unclear]

        monkeypatch.setattr(
            "app.facility.policy_service.load_policy_records",
            _fake_load,
        )
        result = check_content_allowed("Depends Policy Jail", "book", state="ZZ")
        assert result.get("escalation_required") is True
        assert result.get("allowed") is None


class TestIngestCoverage:
    def test_real_csv_count_over_50_when_files_exist(self):
        files = discover_csv_files()
        client_files = [f for f in files if f.name != "sample_policies.csv"]
        if len(client_files) > 50:
            assert len(client_files) > 50

    def test_column_audit_runs(self):
        audit = audit_csv_columns()
        assert audit["file_count"] >= 2
        names = {c["name"] for c in audit["columns"]}
        assert "Facility Name" in names or "Books Allowed" in names

    def test_ingest_main_produces_coverage(self):
        assert ingest_main() == 0
        payload = json.loads((DATA / "facility_policies_normalized.json").read_text(encoding="utf-8"))
        assert payload["source_file_count"] >= 50
        assert payload["facility_count"] >= 50
        assert "coverage" in payload
        load_policy_records(reload=True)
