"""
AI call evaluator — deterministic scoring after call completion.

Optional LLM refinement when ENABLE_LLM_EVAL=true. Never sends secrets or raw PII.
Runs post-call only — never blocks live voice path.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

from ..analytics.metrics_collector import PAYMENT_TOOLS, build_call_metrics
from ..analytics.models import AgentEvaluation, CallMetrics
from ..db import connection as db
from ..db.pii_masking import mask_payload, mask_text
from ..workflow.event_store import get_session_timeline

logger = logging.getLogger(__name__)

# Latency thresholds (ms)
_LATENCY_EXCELLENT = 2000
_LATENCY_GOOD = 3000
_LATENCY_POOR = 5000


def evaluate_call_deterministic(
    metrics: CallMetrics,
    *,
    timeline: Optional[list[dict[str, Any]]] = None,
    tool_events: Optional[list[dict[str, Any]]] = None,
) -> AgentEvaluation:
    """Score a completed call using rules only — no LLM."""
    timeline = timeline or []
    tool_events = tool_events or []
    issues: list[str] = []

    total_tools = metrics.successful_tools + metrics.failed_tools
    if total_tools > 0:
        intent_success = round(100.0 * metrics.successful_tools / total_tools, 1)
    else:
        intent_success = 88.0 if metrics.total_turns > 0 else 70.0

    if metrics.failed_tools > 0:
        issues.append(f"tool_failures:{metrics.failed_tools}")

    tool_selection = 95.0 if metrics.failed_tools == 0 else max(
        0.0, 100.0 - 18.0 * metrics.failed_tools
    )

    response_quality = 90.0
    if metrics.escalation_created:
        response_quality -= 8.0
        issues.append("escalation_created")
    if metrics.failed_tools > 2:
        response_quality -= 12.0
    if metrics.total_turns == 0:
        response_quality = 60.0
        issues.append("no_turns_recorded")

    safety = 100.0
    for te in tool_events:
        tool = te.get("tool_name") or ""
        if tool in PAYMENT_TOOLS and te.get("status") == "failed":
            safety -= 30.0
            issues.append("payment_tool_failed")
        err = (te.get("error_code") or "").lower()
        if "safety" in err or "blocked" in err:
            safety -= 20.0
            issues.append("safety_block_event")

    for ev in timeline:
        payload = ev.get("payload") or {}
        if payload.get("blocked") or payload.get("safety_violation"):
            safety -= 15.0
            issues.append("workflow_safety_flag")

    safety = max(0.0, safety)

    latency_score = _score_latency(metrics.avg_turn_latency_ms, metrics.max_turn_latency_ms, issues)

    overall = round(
        intent_success * 0.22
        + tool_selection * 0.22
        + response_quality * 0.22
        + safety * 0.22
        + latency_score * 0.12,
        1,
    )

    return AgentEvaluation(
        session_id=metrics.session_id,
        intent_success_score=round(intent_success, 1),
        tool_selection_score=round(tool_selection, 1),
        response_quality_score=round(response_quality, 1),
        safety_score=round(safety, 1),
        latency_score=round(latency_score, 1),
        overall_score=overall,
        issues=issues,
    )


def _score_latency(avg_ms: float, max_ms: float, issues: list[str]) -> float:
    score = 100.0
    if avg_ms > _LATENCY_POOR:
        score = 45.0
        issues.append("high_avg_latency")
    elif avg_ms > _LATENCY_GOOD:
        score = 65.0
        issues.append("elevated_avg_latency")
    elif avg_ms > _LATENCY_EXCELLENT:
        score = 82.0
    if max_ms > _LATENCY_POOR:
        score = min(score, 55.0)
        issues.append("high_max_latency")
    return score


def build_evaluator_context(
    metrics: CallMetrics,
    timeline: list[dict[str, Any]],
    tool_events: list[dict[str, Any]],
) -> dict[str, Any]:
    """Masked context safe for optional LLM evaluator."""
    return mask_payload({
        "session_id": metrics.session_id[:12],
        "total_turns": metrics.total_turns,
        "successful_tools": metrics.successful_tools,
        "failed_tools": metrics.failed_tools,
        "payment_link_sent": metrics.payment_link_sent,
        "escalation_created": metrics.escalation_created,
        "avg_turn_latency_ms": round(metrics.avg_turn_latency_ms, 1),
        "intents": [
            (e.get("payload") or {}).get("intent")
            for e in timeline
            if e.get("event_type") == "supervisor_result"
        ][-5:],
        "failed_tool_names": [
            t.get("tool_name") for t in tool_events if t.get("status") == "failed"
        ],
    })


async def _maybe_llm_refine(
    evaluation: AgentEvaluation,
    context: dict[str, Any],
) -> AgentEvaluation:
    from ..config import get_settings

    settings = get_settings()
    if not getattr(settings, "ENABLE_LLM_EVAL", False):
        return evaluation
    if not settings.OPENAI_API_KEY:
        return evaluation

    try:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
        prompt = (
            "You are a voice-agent QA evaluator. Given masked call metrics JSON, "
            "return ONLY a JSON object with keys: response_quality_score (0-100), "
            "issues (list of short strings). No PII."
        )
        resp = await client.chat.completions.create(
            model=settings.OPENAI_FAST_MODEL or "gpt-4o-mini",
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": json.dumps(context)},
            ],
            temperature=0,
            max_tokens=200,
        )
        text = (resp.choices[0].message.content or "").strip()
        data = json.loads(text)
        rq = float(data.get("response_quality_score", evaluation.response_quality_score))
        extra_issues = [str(i) for i in (data.get("issues") or [])][:5]
        merged_issues = list(dict.fromkeys(evaluation.issues + extra_issues))
        overall = round(
            evaluation.intent_success_score * 0.22
            + evaluation.tool_selection_score * 0.22
            + rq * 0.22
            + evaluation.safety_score * 0.22
            + evaluation.latency_score * 0.12,
            1,
        )
        return AgentEvaluation(
            session_id=evaluation.session_id,
            intent_success_score=evaluation.intent_success_score,
            tool_selection_score=evaluation.tool_selection_score,
            response_quality_score=rq,
            safety_score=evaluation.safety_score,
            latency_score=evaluation.latency_score,
            overall_score=overall,
            issues=merged_issues,
        )
    except Exception as exc:
        logger.debug("llm_eval_skipped err=%s", type(exc).__name__)
        return evaluation


async def evaluate_session(session_id: str) -> Optional[AgentEvaluation]:
    """Load metrics/events, score call, optionally refine with LLM, persist."""
    if not db.db_configured():
        return None

    from ..analytics.metrics_collector import _load_tool_events, collect_session_metrics

    metrics = await collect_session_metrics(session_id)
    if metrics is None:
        return None

    timeline = await get_session_timeline(session_id)
    tool_events = await _load_tool_events(session_id)

    evaluation = evaluate_call_deterministic(metrics, timeline=timeline, tool_events=tool_events)
    context = build_evaluator_context(metrics, timeline, tool_events)
    evaluation = await _maybe_llm_refine(evaluation, context)
    await persist_evaluation(evaluation)
    return evaluation


async def persist_evaluation(evaluation: AgentEvaluation) -> None:
    await db.execute_write(
        """
        INSERT INTO agent_evaluations (
            session_id, intent_success_score, tool_selection_score,
            response_quality_score, safety_score, latency_score,
            overall_score, issues_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (session_id) DO UPDATE SET
            intent_success_score = EXCLUDED.intent_success_score,
            tool_selection_score = EXCLUDED.tool_selection_score,
            response_quality_score = EXCLUDED.response_quality_score,
            safety_score = EXCLUDED.safety_score,
            latency_score = EXCLUDED.latency_score,
            overall_score = EXCLUDED.overall_score,
            issues_json = EXCLUDED.issues_json
        """,
        evaluation.session_id,
        evaluation.intent_success_score,
        evaluation.tool_selection_score,
        evaluation.response_quality_score,
        evaluation.safety_score,
        evaluation.latency_score,
        evaluation.overall_score,
        json.dumps(evaluation.issues),
    )


def sanitize_evaluation_for_export(evaluation: AgentEvaluation) -> dict[str, Any]:
    """Ensure no raw PII in exported evaluation dict."""
    return mask_payload(evaluation.to_dict())
