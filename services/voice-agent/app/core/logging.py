"""
Structured logging + per-call cost tracking.

TODO (Milestone 4 — cost logging):
    - configure_logging(level) — sets up JSON structured logging via structlog
      or standard logging with a JSON formatter.
    - CallCostTracker — accumulates token counts and estimated USD cost per call,
      emits a summary log line when the call ends.

Usage (future):
    from app.core.logging import configure_logging, CallCostTracker

    configure_logging(settings.LOG_LEVEL)

    tracker = CallCostTracker(call_sid=call_sid)
    tracker.record_llm_turn(prompt_tokens=120, completion_tokens=80, model="gpt-4o-mini")
    tracker.log_summary()  # emits: {call_sid, total_tokens, estimated_usd, model_mix}
"""
import logging


def configure_logging(level: str = "INFO") -> None:
    """Configure root logger. Called once at application startup."""
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    )
