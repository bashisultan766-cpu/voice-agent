"""
Metrics collector — aggregates workflow_events and tool_events into call_metrics.

All outputs are PII-safe (masked upstream). No secrets in analytics responses.
"""
from __future__ import annotations

import json
import logging
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from ..db import connection as db
from ..db.pii_masking import mask_payload
from ..workflow.event_store import get_session_timeline
from .models import CallMetrics

logger = logging.getLogger(__name__)

PRODUCT_SEARCH_TOOLS = frozenset({
    "search_products",
    "catalog_search",
    "get_product_details",
    "compare_products",
})
ORDER_LOOKUP_TOOLS = frozenset({"lookup_order_status"})
REFUND_LOOKUP_TOOLS = frozenset({"lookup_refund_status"})
FACILITY_TOOLS = frozenset({
    "facility_policy_lookup",
    "search_facility_policy",
    "check_facility_content_allowed",
    "explain_facility_restriction",
    "fetch_facility_policy_analysis",
    "answer_facility_policy_question",
    "explain_facility_delivery_rejection",
    "classify_product_content_for_facility",
})
PAYMENT_TOOLS = frozenset({"send_payment_link", "create_checkout"})
NOT_FOUND_TOOLS = frozenset({"create_product_not_found_escalation"})


def _parse_json_blob(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        return json.loads(raw) if isinstance(raw, str) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _parse_ts(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        text = str(value).replace("Z", "+00:00")
        return datetime.fromisoformat(text)
    except (ValueError, TypeError):
        return None


def _extract_search_term(input_masked: str) -> str:
    data = _parse_json_blob(input_masked)
    for key in ("query", "isbn", "title", "search_term", "identifier"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()[:80]
    return ""


def _extract_facility_query(input_masked: str) -> str:
    data = _parse_json_blob(input_masked)
    for key in ("facility_name", "facility", "question"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()[:80]
    return ""


def build_call_metrics(
    session_id: str,
    *,
    call_sid: str = "",
    session_row: Optional[dict[str, Any]] = None,
    timeline: Optional[list[dict[str, Any]]] = None,
    tool_events: Optional[list[dict[str, Any]]] = None,
) -> CallMetrics:
    """Pure function — build CallMetrics from workflow/tool events (testable)."""
    timeline = timeline or []
    tool_events = tool_events or []

    successful = sum(1 for t in tool_events if t.get("status") == "succeeded")
    failed = sum(1 for t in tool_events if t.get("status") == "failed")

    latencies = [float(t.get("latency_ms") or 0) for t in tool_events if t.get("latency_ms")]
    turn_latencies = _turn_latencies_from_timeline(timeline)
    all_latencies = latencies + turn_latencies

    product_search = sum(1 for t in tool_events if t.get("tool_name") in PRODUCT_SEARCH_TOOLS)
    order_lookup = sum(1 for t in tool_events if t.get("tool_name") in ORDER_LOOKUP_TOOLS)
    refund_lookup = sum(1 for t in tool_events if t.get("tool_name") in REFUND_LOOKUP_TOOLS)
    facility_query = sum(1 for t in tool_events if t.get("tool_name") in FACILITY_TOOLS)

    payment_sent = any(e.get("event_type") == "payment_link_created" for e in timeline)
    escalation = any(e.get("event_type") == "escalation_created" for e in timeline)
    not_found = sum(
        1 for t in tool_events if t.get("tool_name") in NOT_FOUND_TOOLS
    ) + sum(
        1 for e in timeline
        if e.get("event_type") == "escalation_created"
        and (e.get("payload") or {}).get("type") == "product_not_found"
    )

    search_terms: list[str] = []
    facility_terms: list[str] = []
    for t in tool_events:
        name = t.get("tool_name") or ""
        inp = t.get("input_masked") or ""
        if name in PRODUCT_SEARCH_TOOLS:
            term = _extract_search_term(inp)
            if term:
                search_terms.append(term)
        if name in FACILITY_TOOLS:
            fq = _extract_facility_query(inp)
            if fq:
                facility_terms.append(fq)

    runtime_mode = (session_row or {}).get("runtime_mode") or ""
    fallback = runtime_mode not in ("", "orchestrator")

    duration = 0.0
    if session_row:
        started = _parse_ts(session_row.get("started_at"))
        ended = _parse_ts(session_row.get("ended_at"))
        if started and ended:
            duration = max(0.0, (ended - started).total_seconds())

    total_turns = sum(1 for e in timeline if e.get("event_type") == "user_turn_received")

    return CallMetrics(
        session_id=session_id,
        call_sid=call_sid or (session_row or {}).get("call_sid", ""),
        duration_seconds=duration,
        total_turns=total_turns,
        successful_tools=successful,
        failed_tools=failed,
        avg_turn_latency_ms=(sum(all_latencies) / len(all_latencies)) if all_latencies else 0.0,
        max_turn_latency_ms=max(all_latencies) if all_latencies else 0.0,
        payment_link_sent=payment_sent,
        escalation_created=escalation,
        order_lookup_count=order_lookup,
        refund_lookup_count=refund_lookup,
        product_search_count=product_search,
        facility_query_count=facility_query,
        fallback_runtime_used=fallback,
        not_found_escalation_count=not_found,
        top_search_terms=search_terms[:5],
        top_facility_queries=facility_terms[:5],
    )


def _turn_latencies_from_timeline(timeline: list[dict[str, Any]]) -> list[float]:
    latencies: list[float] = []
    turn_start: Optional[datetime] = None
    for ev in timeline:
        if ev.get("event_type") == "user_turn_received":
            turn_start = _parse_ts(ev.get("created_at"))
        elif ev.get("event_type") == "response_sent" and turn_start:
            end = _parse_ts(ev.get("created_at"))
            if end:
                latencies.append(max(0.0, (end - turn_start).total_seconds() * 1000))
            turn_start = None
    return latencies


async def _load_tool_events(session_id: str) -> list[dict[str, Any]]:
    rows = await db.fetch_rows(
        """
        SELECT tool_name, status, turn_id, error_code, latency_ms,
               input_masked, output_masked, created_at
        FROM tool_events
        WHERE session_id = $1
        ORDER BY created_at ASC
        """,
        session_id,
    )
    return rows


async def _load_session_row(session_id: str) -> Optional[dict[str, Any]]:
    rows = await db.fetch_rows(
        """
        SELECT id, call_sid, started_at, ended_at, status, runtime_mode
        FROM call_sessions WHERE id = $1 LIMIT 1
        """,
        session_id,
    )
    return rows[0] if rows else None


async def collect_session_metrics(session_id: str) -> Optional[CallMetrics]:
    """Collect metrics for one session from Postgres workflow/tool events."""
    if not db.postgres_reads_enabled():
        return None
    session_row = await _load_session_row(session_id)
    timeline = await get_session_timeline(session_id)
    tool_events = await _load_tool_events(session_id)
    if not timeline and not tool_events and not session_row:
        return None
    return build_call_metrics(
        session_id,
        call_sid=(session_row or {}).get("call_sid", ""),
        session_row=session_row,
        timeline=timeline,
        tool_events=tool_events,
    )


async def persist_call_metrics(metrics: CallMetrics) -> None:
    await db.execute_write(
        """
        INSERT INTO call_metrics (
            session_id, call_sid, duration_seconds, total_turns,
            successful_tools, failed_tools, avg_turn_latency_ms, max_turn_latency_ms,
            payment_link_sent, escalation_created, order_lookup_count,
            refund_lookup_count, product_search_count, facility_query_count
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (session_id) DO UPDATE SET
            call_sid = EXCLUDED.call_sid,
            duration_seconds = EXCLUDED.duration_seconds,
            total_turns = EXCLUDED.total_turns,
            successful_tools = EXCLUDED.successful_tools,
            failed_tools = EXCLUDED.failed_tools,
            avg_turn_latency_ms = EXCLUDED.avg_turn_latency_ms,
            max_turn_latency_ms = EXCLUDED.max_turn_latency_ms,
            payment_link_sent = EXCLUDED.payment_link_sent,
            escalation_created = EXCLUDED.escalation_created,
            order_lookup_count = EXCLUDED.order_lookup_count,
            refund_lookup_count = EXCLUDED.refund_lookup_count,
            product_search_count = EXCLUDED.product_search_count,
            facility_query_count = EXCLUDED.facility_query_count
        """,
        metrics.session_id,
        metrics.call_sid,
        metrics.duration_seconds,
        metrics.total_turns,
        metrics.successful_tools,
        metrics.failed_tools,
        metrics.avg_turn_latency_ms,
        metrics.max_turn_latency_ms,
        metrics.payment_link_sent,
        metrics.escalation_created,
        metrics.order_lookup_count,
        metrics.refund_lookup_count,
        metrics.product_search_count,
        metrics.facility_query_count,
    )


async def collect_and_persist_session_metrics(session_id: str) -> Optional[CallMetrics]:
    metrics = await collect_session_metrics(session_id)
    if metrics is None:
        return None
    await persist_call_metrics(metrics)
    return metrics


async def collect_aggregate_summary(*, days: int = 7) -> dict[str, Any]:
    """Platform-wide analytics summary — no raw PII."""
    if not db.postgres_reads_enabled():
        return _empty_summary()

    since = datetime.now(timezone.utc) - timedelta(days=days)
    metrics_rows = await db.fetch_rows(
        "SELECT * FROM call_metrics WHERE created_at >= $1",
        since,
    )
    eval_rows = await db.fetch_rows(
        "SELECT overall_score FROM agent_evaluations WHERE created_at >= $1",
        since,
    )
    tool_fail_rows = await db.fetch_rows(
        """
        SELECT tool_name, error_code, COUNT(*) AS cnt
        FROM tool_events
        WHERE status = 'failed' AND created_at >= $1
        GROUP BY tool_name, error_code
        ORDER BY cnt DESC
        LIMIT 20
        """,
        since,
    )

    if not metrics_rows:
        return _empty_summary()

    call_count = len(metrics_rows)
    payment_links = sum(1 for r in metrics_rows if r.get("payment_link_sent"))
    escalations = sum(1 for r in metrics_rows if r.get("escalation_created"))
    product_searches = sum(int(r.get("product_search_count") or 0) for r in metrics_rows)
    order_lookups = sum(int(r.get("order_lookup_count") or 0) for r in metrics_rows)
    refund_requests = sum(int(r.get("refund_lookup_count") or 0) for r in metrics_rows)
    facility_questions = sum(int(r.get("facility_query_count") or 0) for r in metrics_rows)
    failed_tools = sum(int(r.get("failed_tools") or 0) for r in metrics_rows)
    latencies = [float(r.get("avg_turn_latency_ms") or 0) for r in metrics_rows if r.get("avg_turn_latency_ms")]
    avg_latency = sum(latencies) / len(latencies) if latencies else 0.0
    eval_scores = [float(r.get("overall_score") or 0) for r in eval_rows]
    avg_eval = sum(eval_scores) / len(eval_scores) if eval_scores else 0.0

    fallback_rows = await db.fetch_rows(
        """
        SELECT COUNT(*) AS cnt FROM call_sessions
        WHERE created_at >= $1 AND runtime_mode != '' AND runtime_mode != 'orchestrator'
        """,
        since,
    )
    fallback_count = int((fallback_rows[0] if fallback_rows else {}).get("cnt") or 0)

    search_terms = await _top_search_terms(since)
    facility_terms = await _top_facility_terms(since)

    return mask_payload({
        "period_days": days,
        "call_count": call_count,
        "payment_links_sent": payment_links,
        "payment_conversion_rate": round(payment_links / call_count, 3) if call_count else 0.0,
        "escalations": escalations,
        "product_searches": product_searches,
        "order_lookups": order_lookups,
        "refund_requests": refund_requests,
        "facility_questions": facility_questions,
        "average_latency_ms": round(avg_latency, 1),
        "failed_tools": failed_tools,
        "fallback_runtime_calls": fallback_count,
        "top_failure_reasons": [
            {"tool": r.get("tool_name"), "error_code": r.get("error_code"), "count": int(r.get("cnt") or 0)}
            for r in tool_fail_rows
        ],
        "top_search_terms": search_terms,
        "top_facility_queries": facility_terms,
        "average_evaluation_score": round(avg_eval, 1),
    })


async def _top_search_terms(since: datetime, limit: int = 10) -> list[dict[str, Any]]:
    rows = await db.fetch_rows(
        """
        SELECT input_masked FROM tool_events
        WHERE created_at >= $1 AND tool_name = ANY($2::text[])
        """,
        since,
        list(PRODUCT_SEARCH_TOOLS),
    )
    counter: Counter[str] = Counter()
    for r in rows:
        term = _extract_search_term(r.get("input_masked") or "")
        if term:
            counter[term] += 1
    return [{"term": t, "count": c} for t, c in counter.most_common(limit)]


async def _top_facility_terms(since: datetime, limit: int = 10) -> list[dict[str, Any]]:
    rows = await db.fetch_rows(
        """
        SELECT input_masked FROM tool_events
        WHERE created_at >= $1 AND tool_name = ANY($2::text[])
        """,
        since,
        list(FACILITY_TOOLS),
    )
    counter: Counter[str] = Counter()
    for r in rows:
        term = _extract_facility_query(r.get("input_masked") or "")
        if term:
            counter[term] += 1
    return [{"query": t, "count": c} for t, c in counter.most_common(limit)]


async def list_recent_calls(*, limit: int = 50, days: int = 7) -> list[dict[str, Any]]:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = await db.fetch_rows(
        """
        SELECT m.*, e.overall_score
        FROM call_metrics m
        LEFT JOIN agent_evaluations e ON e.session_id = m.session_id
        WHERE m.created_at >= $1
        ORDER BY m.created_at DESC
        LIMIT $2
        """,
        since,
        limit,
    )
    return [mask_payload(CallMetrics.from_row(r).to_dict()) for r in rows]


async def list_failures(*, days: int = 7) -> dict[str, Any]:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = await db.fetch_rows(
        """
        SELECT tool_name, error_code, COUNT(*) AS cnt
        FROM tool_events
        WHERE status = 'failed' AND created_at >= $1
        GROUP BY tool_name, error_code
        ORDER BY cnt DESC
        LIMIT 50
        """,
        since,
    )
    metrics_rows = await db.fetch_rows(
        "SELECT session_id, failed_tools FROM call_metrics WHERE failed_tools > 0 AND created_at >= $1",
        since,
    )
    return mask_payload({
        "period_days": days,
        "tool_failures": [
            {"tool": r.get("tool_name"), "error_code": r.get("error_code"), "count": int(r.get("cnt") or 0)}
            for r in rows
        ],
        "calls_with_failures": len(metrics_rows),
    })


async def list_evaluations(*, limit: int = 50, days: int = 7) -> list[dict[str, Any]]:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = await db.fetch_rows(
        """
        SELECT * FROM agent_evaluations
        WHERE created_at >= $1
        ORDER BY created_at DESC
        LIMIT $2
        """,
        since,
        limit,
    )
    from .models import AgentEvaluation

    return [mask_payload(AgentEvaluation.from_row(r).to_dict()) for r in rows]


def _empty_summary() -> dict[str, Any]:
    return {
        "period_days": 7,
        "call_count": 0,
        "payment_links_sent": 0,
        "payment_conversion_rate": 0.0,
        "escalations": 0,
        "product_searches": 0,
        "order_lookups": 0,
        "refund_requests": 0,
        "facility_questions": 0,
        "average_latency_ms": 0.0,
        "failed_tools": 0,
        "fallback_runtime_calls": 0,
        "top_failure_reasons": [],
        "top_search_terms": [],
        "top_facility_queries": [],
        "average_evaluation_score": 0.0,
    }
