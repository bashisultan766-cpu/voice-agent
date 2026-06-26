"""
Lightweight latency tracer for ConversationRelay pipeline turns.

Logs structured timing per turn. Never logs phone numbers, emails, tokens,
or any other PII. Call SID is truncated to a 6-char non-secret prefix.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class TurnLatency:
    """Timing data for one pipeline turn. All durations in milliseconds."""

    call_sid_partial: str
    intent: str = "unknown"
    router_ms: float = 0.0
    prefetch_ms: float = 0.0
    filler_ms: float = 0.0
    tools_ms: float = 0.0
    openai_first_token_ms: float = 0.0
    total_ms: float = 0.0
    # Populated on first turn only.
    call_setup_ms: float = 0.0
    caller_profile_lookup_ms: float = 0.0
    # Populated when available from tool/email instrumentation.
    shopify_api_ms: float = 0.0
    resend_api_ms: float = 0.0

    # Internal — not included in repr or equality checks.
    _start: float = field(default_factory=time.monotonic, repr=False, compare=False)
    _checkpoints: dict = field(default_factory=dict, repr=False, compare=False)


class LatencyTracer:
    """Creates TurnLatency records and emits them as structured log lines."""

    def start_turn(self, call_sid: str, intent: str = "unknown") -> TurnLatency:
        """Begin timing a new turn."""
        return TurnLatency(
            call_sid_partial=(call_sid[:6] if call_sid else "??????"),
            intent=intent,
        )

    def mark(self, turn: TurnLatency, checkpoint: str) -> float:
        """Record a named checkpoint. Returns elapsed ms since turn start."""
        elapsed = (time.monotonic() - turn._start) * 1000
        turn._checkpoints[checkpoint] = elapsed
        return elapsed

    def finish(self, turn: TurnLatency) -> None:
        """Compute total_ms and emit a single structured log line."""
        turn.total_ms = (time.monotonic() - turn._start) * 1000
        extras = ""
        if turn.call_setup_ms:
            extras += f" call_setup={turn.call_setup_ms:.0f}ms"
        if turn.caller_profile_lookup_ms:
            extras += f" profile={turn.caller_profile_lookup_ms:.0f}ms"
        if turn.shopify_api_ms:
            extras += f" shopify={turn.shopify_api_ms:.0f}ms"
        if turn.resend_api_ms:
            extras += f" resend={turn.resend_api_ms:.0f}ms"
        logger.info(
            "pipeline_latency sid=%s intent=%s "
            "router=%.0fms prefetch=%.0fms filler=%.0fms "
            "tools=%.0fms openai_first=%.0fms total=%.0fms%s",
            turn.call_sid_partial,
            turn.intent,
            turn.router_ms,
            turn.prefetch_ms,
            turn.filler_ms,
            turn.tools_ms,
            turn.openai_first_token_ms,
            turn.total_ms,
            extras,
        )


_tracer = LatencyTracer()


def get_tracer() -> LatencyTracer:
    """Return the module-level singleton tracer."""
    return _tracer
