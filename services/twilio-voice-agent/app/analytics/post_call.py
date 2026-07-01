"""
Post-call analytics hook — metrics collection and evaluation after disconnect.

Fire-and-forget; never blocks live call teardown.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


async def finalize_call_analytics(session: "SessionState") -> None:
    """Collect per-call metrics and run evaluator after call ends."""
    from ..config import get_settings

    if not get_settings().DATABASE_URL:
        return

    session_id = (getattr(session, "session_id", "") or "").strip()
    if not session_id:
        return

    try:
        from ..analytics.metrics_collector import collect_and_persist_session_metrics
        from ..evaluation.call_evaluator import evaluate_session

        metrics = await collect_and_persist_session_metrics(session_id)
        if metrics is None:
            logger.debug("post_call_metrics_skipped session=%s", session_id[:8])
            return
        await evaluate_session(session_id)
        logger.info(
            "post_call_analytics_complete session=%s turns=%d tools_ok=%d tools_fail=%d",
            session_id[:8],
            metrics.total_turns,
            metrics.successful_tools,
            metrics.failed_tools,
        )
    except Exception as exc:
        from ..config import get_settings

        settings = get_settings()
        if settings.STRICT_POSTGRES:
            raise
        if settings.is_production:
            logger.error("post_call_analytics_failed err=%s", type(exc).__name__)
        else:
            logger.debug("post_call_analytics_skipped err=%s", type(exc).__name__)
