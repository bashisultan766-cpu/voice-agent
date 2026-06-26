"""
v4.1 tests — FacilityApprovalWorker, FacilityRestrictionWorker,
             FacilityPolicyNotesWorker, OrderFacilityReviewWorker.
"""
from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")


def _make_session(verified: bool = False):
    from app.state.models import SessionState
    s = SessionState(
        session_id="test", call_sid="CA123",
        from_number="+15005550006", to_number="+15005550007",
    )
    if verified:
        s.verified_email = True
        s.caller_email = "test@example.com"
    return s


def _make_settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True)


def _order_json(tags="", note="", attrs=None, items=None):
    """Build minimal lookup_order JSON response (matches shopify_tools.lookup_order shape)."""
    attrs_list = attrs or []
    if attrs_list and isinstance(attrs_list[0], dict):
        custom_attributes = {a.get("key", ""): a.get("value", "") for a in attrs_list}
    else:
        custom_attributes = dict(attrs_list) if attrs_list else {}
    tag_list = tags if isinstance(tags, list) else (
        [t.strip() for t in tags.split(",") if t.strip()] if tags else []
    )
    return json.dumps({
        "found": True,
        "order_number": "#1001",
        "status": "PAID",
        "fulfillment_status": "FULFILLED",
        "note": note,
        "tags": tag_list,
        "custom_attributes": custom_attributes,
        "items": items or [],
    })


# ── FacilityApprovalWorker ───────────────────────────────────────────────────

class TestFacilityApprovalWorker:
    async def test_no_facility_name_returns_prompt(self):
        from app.facility.approval_worker import FacilityApprovalWorker
        worker = FacilityApprovalWorker()
        result = await worker.run(_make_session(), {}, _make_settings())
        assert result.success is False
        assert result.error_code == "no_facility"

    async def test_approved_tag_detected(self):
        from app.facility.approval_worker import FacilityApprovalWorker
        worker = FacilityApprovalWorker()
        order_resp = _order_json(tags="facility_approved, customer")
        with patch("app.tools.shopify_tools.lookup_order",
                   AsyncMock(return_value=order_resp)):
            result = await worker.run(
                _make_session(),
                {"facility_name": "Rikers Island", "order_number": "#1001"},
                _make_settings(),
            )
        assert result.success is True
        assert result.data["approval_status"] == "approved"
        assert "Rikers Island" in result.safe_summary

    async def test_rejected_tag_detected(self):
        from app.facility.approval_worker import FacilityApprovalWorker
        worker = FacilityApprovalWorker()
        order_resp = _order_json(tags="facility_rejected")
        with patch("app.tools.shopify_tools.lookup_order",
                   AsyncMock(return_value=order_resp)):
            result = await worker.run(
                _make_session(),
                {"facility_name": "State Prison", "order_number": "#1001"},
                _make_settings(),
            )
        assert result.data["approval_status"] == "rejected"

    async def test_unknown_status_without_order(self):
        from app.facility.approval_worker import FacilityApprovalWorker
        worker = FacilityApprovalWorker()
        result = await worker.run(
            _make_session(),
            {"facility_name": "Unknown Jail"},
            _make_settings(),
        )
        assert result.success is True
        assert result.data["approval_status"] == "unknown"

    async def test_facility_stored_in_session(self):
        from app.facility.approval_worker import FacilityApprovalWorker
        worker = FacilityApprovalWorker()
        session = _make_session()
        await worker.run(session, {"facility_name": "County Jail"}, _make_settings())
        assert session.last_facility_name == "County Jail"


# ── FacilityRestrictionWorker ────────────────────────────────────────────────

class TestFacilityRestrictionWorker:
    async def test_no_facility_returns_prompt(self):
        from app.facility.restriction_worker import FacilityRestrictionWorker
        worker = FacilityRestrictionWorker()
        result = await worker.run(_make_session(), {}, _make_settings())
        assert result.success is False
        assert result.error_code == "no_facility"

    async def test_hardcover_ban_from_note(self):
        from app.facility.restriction_worker import FacilityRestrictionWorker
        worker = FacilityRestrictionWorker()
        order_resp = _order_json(note="No hardcover books allowed at this facility")
        with patch("app.tools.shopify_tools.lookup_order",
                   AsyncMock(return_value=order_resp)):
            result = await worker.run(
                _make_session(),
                {"facility_name": "Camp X", "order_number": "#1001"},
                _make_settings(),
            )
        assert result.success is True
        assert any("hardcover" in r.lower() for r in result.data["restrictions"])

    async def test_no_restrictions_returns_default_guidance(self):
        from app.facility.restriction_worker import FacilityRestrictionWorker
        worker = FacilityRestrictionWorker()
        result = await worker.run(
            _make_session(),
            {"facility_name": "New Prison"},
            _make_settings(),
        )
        assert result.success is True
        assert "restriction" in result.safe_summary.lower() or "softcover" in result.safe_summary.lower()


# ── FacilityPolicyNotesWorker ────────────────────────────────────────────────

class TestFacilityPolicyNotesWorker:
    async def test_default_policy_when_no_order(self):
        from app.workers.facility_policy_notes_worker import FacilityPolicyNotesWorker
        worker = FacilityPolicyNotesWorker()
        result = await worker.run(
            _make_session(),
            {"facility_name": "County Correctional"},
            _make_settings(),
        )
        assert result.success is True
        assert result.data["default_used"] is True
        assert "directly" in result.safe_summary.lower()

    async def test_note_from_order_used(self):
        from app.workers.facility_policy_notes_worker import FacilityPolicyNotesWorker
        worker = FacilityPolicyNotesWorker()
        order_resp = _order_json(note="Only paperback books accepted. Inmate must be listed.")
        with patch("app.tools.shopify_tools.lookup_order",
                   AsyncMock(return_value=order_resp)):
            result = await worker.run(
                _make_session(),
                {"facility_name": "State Pen", "order_number": "#1001"},
                _make_settings(),
            )
        assert result.success is True
        assert result.data["default_used"] is False
        assert "paperback" in result.safe_summary.lower()


# ── OrderFacilityReviewWorker ────────────────────────────────────────────────

class TestOrderFacilityReviewWorker:
    async def test_no_order_number_returns_prompt(self):
        from app.workers.order_facility_review_worker import OrderFacilityReviewWorker
        worker = OrderFacilityReviewWorker()
        result = await worker.run(_make_session(), {}, _make_settings())
        assert result.success is False
        assert result.error_code == "no_order_number"

    async def test_unverified_returns_verification_prompt(self):
        from app.workers.order_facility_review_worker import OrderFacilityReviewWorker
        worker = OrderFacilityReviewWorker()
        result = await worker.run(
            _make_session(verified=False),
            {"order_number": "#1001"},
            _make_settings(),
        )
        assert result.success is True
        assert result.requires_verification is True

    async def test_returned_by_facility_detected(self):
        from app.workers.order_facility_review_worker import OrderFacilityReviewWorker
        worker = OrderFacilityReviewWorker()
        order_resp = _order_json(tags="facility_returned, returned")
        with patch("app.tools.shopify_tools.lookup_order",
                   AsyncMock(return_value=order_resp)):
            result = await worker.run(
                _make_session(verified=True),
                {"order_number": "#1001"},
                _make_settings(),
            )
        assert result.success is True
        assert result.data["issues"].get("returned_by_facility") is True
        assert "returned" in result.safe_summary.lower()

    async def test_no_facility_issues_clean_order(self):
        from app.workers.order_facility_review_worker import OrderFacilityReviewWorker
        worker = OrderFacilityReviewWorker()
        order_resp = _order_json(tags="paid, fulfilled")
        with patch("app.tools.shopify_tools.lookup_order",
                   AsyncMock(return_value=order_resp)):
            result = await worker.run(
                _make_session(verified=True),
                {"order_number": "#1001"},
                _make_settings(),
            )
        assert result.success is True
        assert result.data["issues"] == {}

    async def test_order_not_found(self):
        from app.workers.order_facility_review_worker import OrderFacilityReviewWorker
        worker = OrderFacilityReviewWorker()
        with patch("app.tools.shopify_tools.lookup_order",
                   AsyncMock(return_value=json.dumps({"found": False, "orders": []}))):
            result = await worker.run(
                _make_session(verified=True),
                {"order_number": "#9999"},
                _make_settings(),
            )
        assert result.data.get("found") is False
