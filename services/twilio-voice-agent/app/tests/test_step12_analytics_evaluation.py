"""
Step 12 — analytics, evaluation, and monitoring tests.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.analytics.metrics_collector import build_call_metrics
from app.analytics.models import CallMetrics
from app.config import Settings, get_settings
from app.evaluation.call_evaluator import (
    build_evaluator_context,
    evaluate_call_deterministic,
    sanitize_evaluation_for_export,
)
from app.main import create_app


def _tool(name: str, status: str, latency: float = 100.0, inp: str = "") -> dict:
    return {
        "tool_name": name,
        "status": status,
        "latency_ms": latency,
        "input_masked": inp,
    }


def _event(event_type: str, payload: dict | None = None, ts: str = "") -> dict:
    return {
        "event_type": event_type,
        "payload": payload or {},
        "created_at": ts or "2026-06-26T12:00:00+00:00",
    }


# ── 1–4. Metrics collector ───────────────────────────────────────────────────


def test_metrics_collector_counts_tool_success_failures():
    tools = [
        _tool("search_products", "succeeded"),
        _tool("search_products", "succeeded"),
        _tool("lookup_order_status", "failed"),
    ]
    m = build_call_metrics("sess-1", tool_events=tools)
    assert m.successful_tools == 2
    assert m.failed_tools == 1


def test_metrics_collector_counts_payment_links():
    timeline = [_event("payment_link_created", {"email_sent": True})]
    m = build_call_metrics("sess-2", timeline=timeline)
    assert m.payment_link_sent is True


def test_metrics_collector_counts_escalations():
    timeline = [_event("escalation_created", {"type": "human_escalation"})]
    m = build_call_metrics("sess-3", timeline=timeline)
    assert m.escalation_created is True


def test_metrics_collector_counts_product_searches():
    tools = [
        _tool("search_products", "succeeded", inp='{"query": "ISBN 978123"}'),
        _tool("catalog_search", "succeeded", inp='{"query": "Harry Potter"}'),
    ]
    m = build_call_metrics("sess-4", tool_events=tools)
    assert m.product_search_count == 2
    assert len(m.top_search_terms) == 2


# ── 5–8. Evaluator ───────────────────────────────────────────────────────────


def test_evaluator_masks_pii():
    metrics = CallMetrics(session_id="sess-eval")
    timeline = [
        _event("user_turn_received", {"text_len": 10}),
        _event("supervisor_result", {"intent": "checkout_payment"}),
    ]
    tools = [
        _tool(
            "send_payment_link",
            "succeeded",
            inp='{"email": "secret@user.com", "checkout_url": "https://pay.shopify.com/x?token=abc"}',
        )
    ]
    ctx = build_evaluator_context(metrics, timeline, tools)
    blob = json.dumps(ctx)
    assert "secret@user.com" not in blob
    assert "token=abc" not in blob


def test_evaluator_produces_deterministic_score():
    metrics = CallMetrics(
        session_id="sess-score",
        successful_tools=3,
        failed_tools=0,
        total_turns=3,
        avg_turn_latency_ms=1500,
    )
    ev = evaluate_call_deterministic(metrics)
    assert ev.overall_score > 0
    assert ev.intent_success_score == 100.0
    assert ev.tool_selection_score >= 90


def test_low_safety_event_lowers_score():
    metrics = CallMetrics(session_id="sess-safety", successful_tools=1, failed_tools=1)
    tools = [_tool("send_payment_link", "failed")]
    tools[0]["error_code"] = "safety_blocked"
    ev = evaluate_call_deterministic(metrics, tool_events=tools)
    assert ev.safety_score < 100
    assert any("payment" in i for i in ev.issues)


def test_high_latency_lowers_score():
    metrics = CallMetrics(
        session_id="sess-latency",
        successful_tools=2,
        failed_tools=0,
        total_turns=2,
        avg_turn_latency_ms=6000,
        max_turn_latency_ms=8000,
    )
    ev = evaluate_call_deterministic(metrics)
    assert ev.latency_score < 60
    assert "high_avg_latency" in ev.issues


# ── 9–10. Admin analytics endpoints ──────────────────────────────────────────


def test_admin_analytics_endpoint_requires_key():
    app = create_app()
    get_settings.cache_clear()
    with patch.dict(
        os.environ,
        {
            "ENABLE_ADMIN_DEBUG_ENDPOINTS": "true",
            "INTERNAL_ADMIN_KEY": "analytics-key",
            "APP_ENV": "test",
        },
        clear=False,
    ):
        get_settings.cache_clear()
        client = TestClient(app)
        assert client.get("/admin/analytics/summary").status_code == 403
        ok = client.get(
            "/admin/analytics/summary",
            headers={"X-Admin-Key": "analytics-key"},
        )
        assert ok.status_code == 200


def test_admin_analytics_endpoint_disabled_by_default():
    app = create_app()
    get_settings.cache_clear()
    with patch.dict(
        os.environ,
        {
            "ENABLE_ADMIN_DEBUG_ENDPOINTS": "false",
            "INTERNAL_ADMIN_KEY": "analytics-key",
            "APP_ENV": "test",
        },
        clear=False,
    ):
        get_settings.cache_clear()
        client = TestClient(app)
        r = client.get(
            "/admin/analytics/summary",
            headers={"X-Admin-Key": "analytics-key"},
        )
        assert r.status_code == 404


# ── 11. Daily report script ───────────────────────────────────────────────────


def test_daily_report_script_creates_markdown(tmp_path):
    import importlib.util
    import sys

    summary = {
        "call_count": 5,
        "payment_links_sent": 2,
        "product_searches": 8,
        "escalations": 1,
        "order_lookups": 3,
        "refund_requests": 1,
        "facility_questions": 4,
        "average_latency_ms": 2100,
        "failed_tools": 2,
        "top_failure_reasons": [{"tool": "search_products", "error_code": "timeout", "count": 2}],
        "top_search_terms": [{"term": "ISBN ***", "count": 3}],
        "top_facility_queries": [{"query": "Arizona DOC", "count": 2}],
        "average_evaluation_score": 84.5,
        "fallback_runtime_calls": 0,
    }

    async def _fake_summary(days=1):
        return summary

    script_path = Path(__file__).resolve().parents[2] / "scripts" / "generate_daily_voice_agent_report.py"
    spec = importlib.util.spec_from_file_location("daily_report_mod", script_path)
    daily_mod = importlib.util.module_from_spec(spec)
    sys.modules["daily_report_mod"] = daily_mod
    assert spec.loader is not None
    spec.loader.exec_module(daily_mod)

    out_dir = tmp_path / "reports"
    with patch(
        "app.analytics.metrics_collector.collect_aggregate_summary",
        _fake_summary,
    ):
        with patch(
            "sys.argv",
            ["generate_daily_voice_agent_report.py", "--output-dir", str(out_dir), "--date", "2026-06-26"],
        ):
            assert daily_mod.main() == 0

    report = out_dir / "2026-06-26_voice_agent_report.md"
    assert report.exists()
    text = report.read_text(encoding="utf-8")
    assert "Total calls" in text
    assert "5" in text
    assert "Recommended fixes" in text


# ── 12. No raw PII in analytics output ───────────────────────────────────────


def test_no_raw_pii_in_analytics_output():
    from app.db.pii_masking import mask_payload

    metrics = CallMetrics(
        session_id="sess-pii",
        call_sid="CA999",
        successful_tools=1,
        failed_tools=0,
        total_turns=1,
        payment_link_sent=True,
    )
    tools = [
        _tool(
            "send_payment_link",
            "succeeded",
            inp=json.dumps({
                "email": "buyer@secret.com",
                "phone": "+14155551234",
                "checkout_url": "https://checkout.shopify.com/carts/abc?key=supersecret",
            }),
        )
    ]
    m = build_call_metrics("sess-pii", tool_events=tools)
    ev = evaluate_call_deterministic(m, tool_events=tools)
    exported = sanitize_evaluation_for_export(ev)
    blob = json.dumps(mask_payload({"metrics": m.to_dict(), "evaluation": exported}))
    assert "buyer@secret.com" not in blob
    assert "+14155551234" not in blob
    assert "supersecret" not in blob
