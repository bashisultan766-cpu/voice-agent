"""
v4.1 tests — enhanced RefundWorker: shipping refund, item detail, note, masked email.
"""
from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")


def _make_session(verified: bool = True):
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


def _refund_json(refunds=None, order_email=""):
    return json.dumps({
        "found": True,
        "refund_count": len(refunds or []),
        "refunds": refunds or [],
        "order_email": order_email,
    })


class TestRefundWorkerV41:
    async def test_shipping_refunded_in_summary(self):
        from app.workers.refund_worker import RefundWorker
        worker = RefundWorker()
        session = _make_session(verified=True)
        refund_data = _refund_json(refunds=[{
            "amount": "$12.99",
            "date": "2026-06-15",
            "items": [{"title": "Dune", "quantity": 1, "amount": "$9.99"}],
            "shipping_refunded": True,
            "shipping_amount": "$3.00",
            "note": "",
        }])
        with patch("app.tools.shopify_tools.get_refund_status",
                   AsyncMock(return_value=refund_data)):
            result = await worker.run(session, {"order_number": "#1001"}, _make_settings())
        assert result.success is True
        assert "shipping refunded" in result.safe_summary.lower()
        assert result.data["refund_summaries"][0]["shipping_refunded"] is True

    async def test_item_detail_in_summary(self):
        from app.workers.refund_worker import RefundWorker
        worker = RefundWorker()
        session = _make_session(verified=True)
        refund_data = _refund_json(refunds=[{
            "amount": "$9.99",
            "date": "2026-06-10",
            "items": [{"title": "The Great Gatsby", "quantity": 1, "amount": "$9.99"}],
            "shipping_refunded": False,
            "shipping_amount": "",
            "note": "",
        }])
        with patch("app.tools.shopify_tools.get_refund_status",
                   AsyncMock(return_value=refund_data)):
            result = await worker.run(session, {"order_number": "#1002"}, _make_settings())
        assert "Great Gatsby" in result.safe_summary

    async def test_safe_note_included(self):
        from app.workers.refund_worker import RefundWorker
        worker = RefundWorker()
        session = _make_session(verified=True)
        refund_data = _refund_json(refunds=[{
            "amount": "$5.00",
            "date": "2026-06-01",
            "items": [],
            "shipping_refunded": False,
            "shipping_amount": "",
            "note": "Facility rejected paperback",
        }])
        with patch("app.tools.shopify_tools.get_refund_status",
                   AsyncMock(return_value=refund_data)):
            result = await worker.run(session, {"order_number": "#1003"}, _make_settings())
        assert "Facility rejected paperback" in result.safe_summary

    async def test_sensitive_note_redacted(self):
        from app.workers.refund_worker import _safe_note
        assert _safe_note("SSN 123456789") == ""
        assert _safe_note("routing number 111222333") == ""

    async def test_safe_note_passes(self):
        from app.workers.refund_worker import _safe_note
        assert _safe_note("Facility rejected paperback") == "Facility rejected paperback"

    async def test_masked_email_in_data(self):
        from app.workers.refund_worker import RefundWorker
        worker = RefundWorker()
        session = _make_session(verified=True)
        refund_data = _refund_json(refunds=[{
            "amount": "$8.00", "date": "2026-06-05",
            "items": [], "shipping_refunded": False,
            "shipping_amount": "", "note": "",
        }], order_email="alice@example.com")
        with patch("app.tools.shopify_tools.get_refund_status",
                   AsyncMock(return_value=refund_data)):
            result = await worker.run(session, {"order_number": "#1004"}, _make_settings())
        masked = result.data.get("masked_email", "")
        assert "@" in masked
        assert "alice" not in masked or masked.startswith("a***")
        # Full email must NOT appear in safe_summary
        assert "alice@example.com" not in result.safe_summary

    async def test_unverified_blocks_details(self):
        from app.workers.refund_worker import RefundWorker
        worker = RefundWorker()
        session = _make_session(verified=False)
        result = await worker.run(session, {"order_number": "#1001"}, _make_settings())
        assert result.requires_verification is True
        assert "verify" in result.safe_summary.lower()

    async def test_no_refunds_message(self):
        from app.workers.refund_worker import RefundWorker
        worker = RefundWorker()
        session = _make_session(verified=True)
        with patch("app.tools.shopify_tools.get_refund_status",
                   AsyncMock(return_value=_refund_json(refunds=[]))):
            result = await worker.run(session, {"order_number": "#1005"}, _make_settings())
        assert result.success is True
        assert "no refunds" in result.safe_summary.lower()
