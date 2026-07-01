"""
Analytics models — per-call metrics and aggregate summaries.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any, Optional


@dataclass
class CallMetrics:
    session_id: str
    call_sid: str = ""
    duration_seconds: float = 0.0
    total_turns: int = 0
    successful_tools: int = 0
    failed_tools: int = 0
    avg_turn_latency_ms: float = 0.0
    max_turn_latency_ms: float = 0.0
    payment_link_sent: bool = False
    escalation_created: bool = False
    order_lookup_count: int = 0
    refund_lookup_count: int = 0
    product_search_count: int = 0
    facility_query_count: int = 0
    created_at: Optional[str] = None
    # Aggregate-only fields (not persisted on call_metrics row)
    fallback_runtime_used: bool = False
    not_found_escalation_count: int = 0
    top_search_terms: list[str] = field(default_factory=list)
    top_facility_queries: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "CallMetrics":
        return cls(
            session_id=str(row.get("session_id") or ""),
            call_sid=str(row.get("call_sid") or ""),
            duration_seconds=float(row.get("duration_seconds") or 0),
            total_turns=int(row.get("total_turns") or 0),
            successful_tools=int(row.get("successful_tools") or 0),
            failed_tools=int(row.get("failed_tools") or 0),
            avg_turn_latency_ms=float(row.get("avg_turn_latency_ms") or 0),
            max_turn_latency_ms=float(row.get("max_turn_latency_ms") or 0),
            payment_link_sent=bool(row.get("payment_link_sent")),
            escalation_created=bool(row.get("escalation_created")),
            order_lookup_count=int(row.get("order_lookup_count") or 0),
            refund_lookup_count=int(row.get("refund_lookup_count") or 0),
            product_search_count=int(row.get("product_search_count") or 0),
            facility_query_count=int(row.get("facility_query_count") or 0),
            created_at=_iso(row.get("created_at")),
        )


@dataclass
class AgentEvaluation:
    session_id: str
    intent_success_score: float = 0.0
    tool_selection_score: float = 0.0
    response_quality_score: float = 0.0
    safety_score: float = 0.0
    latency_score: float = 0.0
    overall_score: float = 0.0
    issues: list[str] = field(default_factory=list)
    created_at: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["issues_json"] = json.dumps(self.issues)
        return d

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "AgentEvaluation":
        issues_raw = row.get("issues_json") or "[]"
        try:
            issues = json.loads(issues_raw) if isinstance(issues_raw, str) else list(issues_raw or [])
        except (json.JSONDecodeError, TypeError):
            issues = []
        return cls(
            session_id=str(row.get("session_id") or ""),
            intent_success_score=float(row.get("intent_success_score") or 0),
            tool_selection_score=float(row.get("tool_selection_score") or 0),
            response_quality_score=float(row.get("response_quality_score") or 0),
            safety_score=float(row.get("safety_score") or 0),
            latency_score=float(row.get("latency_score") or 0),
            overall_score=float(row.get("overall_score") or 0),
            issues=list(issues),
            created_at=_iso(row.get("created_at")),
        )


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)
