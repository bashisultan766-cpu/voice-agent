#!/usr/bin/env python3
"""
Generate daily voice-agent analytics report.

Usage:
    python scripts/generate_daily_voice_agent_report.py
    python scripts/generate_daily_voice_agent_report.py --date 2026-06-26

Output: docs/reports/YYYY-MM-DD_voice_agent_report.md
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _recommended_fixes(summary: dict) -> list[str]:
    fixes: list[str] = []
    if summary.get("failed_tools", 0) > 5:
        fixes.append("Investigate top tool failure reasons in `/admin/analytics/failures`.")
    if summary.get("average_latency_ms", 0) > 3000:
        fixes.append("Review turn latency — consider supervisor/composer LLM skip paths.")
    if summary.get("escalations", 0) > summary.get("call_count", 1) * 0.2:
        fixes.append("High escalation rate — audit product catalog coverage and facility policy answers.")
    if summary.get("payment_conversion_rate", 0) < 0.1 and summary.get("call_count", 0) > 3:
        fixes.append("Low payment conversion — verify email confirmation FSM and checkout tool health.")
    if summary.get("fallback_runtime_calls", 0) > 0:
        fixes.append("Legacy runtime fallback detected — check orchestrator stability logs.")
    if not fixes:
        fixes.append("No critical issues detected — continue monitoring evaluation scores.")
    return fixes


def _render_report(report_date: date, summary: dict) -> str:
    failures = summary.get("top_failure_reasons") or []
    failure_lines = "\n".join(
        f"- `{f.get('tool')}` / `{f.get('error_code')}` — {f.get('count')} occurrences"
        for f in failures[:10]
    ) or "- None recorded"

    search_lines = "\n".join(
        f"- {s.get('term', '?')} ({s.get('count', 0)})"
        for s in (summary.get("top_search_terms") or [])[:10]
    ) or "- None recorded"

    facility_lines = "\n".join(
        f"- {s.get('query', '?')} ({s.get('count', 0)})"
        for s in (summary.get("top_facility_queries") or [])[:10]
    ) or "- None recorded"

    fixes = _recommended_fixes(summary)
    fix_lines = "\n".join(f"- {f}" for f in fixes)

    return f"""# Voice Agent Daily Report — {report_date.isoformat()}

**Generated:** {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}

## Summary

| Metric | Value |
|--------|------:|
| Total calls | {summary.get('call_count', 0)} |
| Payment links sent | {summary.get('payment_links_sent', 0)} |
| Product searches | {summary.get('product_searches', 0)} |
| Not-found escalations | {summary.get('escalations', 0)} |
| Order lookups | {summary.get('order_lookups', 0)} |
| Refund requests | {summary.get('refund_requests', 0)} |
| Facility questions | {summary.get('facility_questions', 0)} |
| Average latency (ms) | {summary.get('average_latency_ms', 0)} |
| Failed tools | {summary.get('failed_tools', 0)} |
| Avg evaluation score | {summary.get('average_evaluation_score', 0)} |
| Fallback runtime calls | {summary.get('fallback_runtime_calls', 0)} |

## Top failure reasons

{failure_lines}

## Top search terms

{search_lines}

## Top facility queries

{facility_lines}

## Recommended fixes

{fix_lines}
"""


async def _build_summary(days: int = 1) -> dict:
    from app.analytics.metrics_collector import collect_aggregate_summary

    return await collect_aggregate_summary(days=days)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate daily voice agent report")
    parser.add_argument("--date", help="Report date YYYY-MM-DD (default: today UTC)")
    parser.add_argument("--days", type=int, default=1, help="Lookback window in days")
    parser.add_argument("--output-dir", help="Override output directory")
    args = parser.parse_args()

    if args.date:
        report_date = date.fromisoformat(args.date)
    else:
        report_date = datetime.now(timezone.utc).date()

    summary = asyncio.run(_build_summary(days=args.days))

    out_dir = Path(args.output_dir) if args.output_dir else ROOT.parent.parent / "docs" / "reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{report_date.isoformat()}_voice_agent_report.md"
    out_path.write_text(_render_report(report_date, summary), encoding="utf-8")
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
