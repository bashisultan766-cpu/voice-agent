from __future__ import annotations
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger("voice.tracer")


@dataclass
class ToolTrace:
    """Per-tool timing and outcome record."""

    name: str
    args_summary: str  # truncated JSON for observability
    launched_at_ms: float
    completed_at_ms: Optional[float] = None
    latency_ms: Optional[int] = None
    failed: bool = False
    error: Optional[str] = None
    from_cache: bool = False  # served from speculative pre-fetch
    success: bool = True
    fallback_reason: Optional[str] = None

    def mark_complete(
        self,
        *,
        failed: bool = False,
        error: Optional[str] = None,
        from_cache: bool = False,
        fallback_reason: Optional[str] = None,
    ) -> None:
        now_ms = time.monotonic() * 1000
        self.completed_at_ms = now_ms
        self.latency_ms = int(now_ms - self.launched_at_ms)
        self.failed = failed
        self.success = not failed
        self.error = error
        self.from_cache = from_cache
        self.fallback_reason = fallback_reason
        logger.info(
            "voice_tool_completed",
            extra={
                "tool_name": self.name,
                "latency_ms": self.latency_ms,
                "success": self.success,
                "failed": self.failed,
                "fallback_reason": fallback_reason,
                "from_cache": from_cache,
            },
        )


@dataclass
class VoiceTurnTrace:
    """Full observability snapshot for one voice turn."""

    turn_id: str
    call_sid: str
    agent_id: str
    tenant_id: str
    transcript: str
    intent: str
    intent_confidence: float
    entities: Dict[str, Any]
    tool_traces: List[ToolTrace]
    total_latency_ms: int
    response_mode: str  # "instant" | "llm" | "fallback"
    fallback_reason: Optional[str]
    latency_breakdown: Dict[str, int] = field(default_factory=dict)

    @property
    def launched_tools(self) -> List[str]:
        return [t.name for t in self.tool_traces]

    @property
    def completed_tools(self) -> List[str]:
        return [
            t.name for t in self.tool_traces
            if not t.failed and t.completed_at_ms is not None
        ]

    @property
    def failed_tools(self) -> List[str]:
        return [t.name for t in self.tool_traces if t.failed]

    @property
    def cache_hits(self) -> List[str]:
        return [t.name for t in self.tool_traces if t.from_cache]

    def to_log_dict(self) -> Dict[str, Any]:
        return {
            "turn_id": self.turn_id,
            "call_sid": self.call_sid,
            "agent_id": self.agent_id,
            "tenant_id": self.tenant_id,
            "transcript_chars": len(self.transcript),
            "intent": self.intent,
            "intent_confidence": round(self.intent_confidence, 3),
            "entities": self.entities,
            "launched_tools": self.launched_tools,
            "completed_tools": self.completed_tools,
            "failed_tools": self.failed_tools,
            "cache_hits": self.cache_hits,
            "tool_latencies_ms": {
                t.name: t.latency_ms
                for t in self.tool_traces
                if t.latency_ms is not None
            },
            "total_latency_ms": self.total_latency_ms,
            "latency_breakdown": self.latency_breakdown,
            "response_mode": self.response_mode,
            "fallback_reason": self.fallback_reason,
        }


class TurnTracer:
    """
    Mutable builder that accumulates per-turn metrics during processing.

    Usage:
        tracer = TurnTracer(call_sid=..., agent_id=..., ...)
        tracer.set_intent(...)
        tt = tracer.tool_launched("product_search", args)
        ...
        tt.mark_complete()
        trace = tracer.finalize()   # emits structured log line
    """

    def __init__(
        self,
        call_sid: str,
        agent_id: str,
        tenant_id: str,
        transcript: str,
    ) -> None:
        self.turn_id = str(uuid.uuid4())
        self.call_sid = call_sid
        self.agent_id = agent_id
        self.tenant_id = tenant_id
        self.transcript = transcript
        self._start_ms = time.monotonic() * 1000
        self._intent = "unknown"
        self._intent_confidence = 0.0
        self._entities: Dict[str, Any] = {}
        self._tool_traces: List[ToolTrace] = []
        self._response_mode = "llm"
        self._fallback_reason: Optional[str] = None
        self._latency_breakdown: Dict[str, int] = {}

    def set_intent(
        self,
        intent: str,
        confidence: float,
        entities: Dict[str, Any],
    ) -> None:
        self._intent = intent
        self._intent_confidence = confidence
        self._entities = entities

    def record_step(
        self,
        step_name: str,
        latency_ms: int,
        *,
        success: bool = True,
        fallback_reason: Optional[str] = None,
    ) -> None:
        self._latency_breakdown[step_name] = latency_ms
        logger.info(
            "voice_step_completed",
            extra={
                "turn_id": self.turn_id,
                "call_sid": self.call_sid,
                "tool_name": step_name,
                "latency_ms": latency_ms,
                "success": success,
                "fallback_reason": fallback_reason,
            },
        )

    def tool_launched(self, name: str, args: Dict[str, Any]) -> ToolTrace:
        """Register a tool launch; returns a ToolTrace to be mutated on completion."""
        trace = ToolTrace(
            name=name,
            args_summary=json.dumps(args, default=str)[:120],
            launched_at_ms=time.monotonic() * 1000,
        )
        self._tool_traces.append(trace)
        logger.info(
            "voice_tool_launched",
            extra={
                "turn_id": self.turn_id,
                "call_sid": self.call_sid,
                "tool_name": name,
            },
        )
        return trace

    def set_response_mode(self, mode: str, fallback_reason: Optional[str] = None) -> None:
        self._response_mode = mode
        self._fallback_reason = fallback_reason

    def finalize(self) -> VoiceTurnTrace:
        """Emit a structured log line and return the frozen VoiceTurnTrace."""
        total_ms = int(time.monotonic() * 1000 - self._start_ms)
        trace = VoiceTurnTrace(
            turn_id=self.turn_id,
            call_sid=self.call_sid,
            agent_id=self.agent_id,
            tenant_id=self.tenant_id,
            transcript=self.transcript,
            intent=self._intent,
            intent_confidence=self._intent_confidence,
            entities=self._entities,
            tool_traces=list(self._tool_traces),
            total_latency_ms=total_ms,
            response_mode=self._response_mode,
            fallback_reason=self._fallback_reason,
            latency_breakdown=dict(self._latency_breakdown),
        )
        logger.info(
            "voice_turn_completed",
            extra={"trace": trace.to_log_dict()},
        )
        return trace
