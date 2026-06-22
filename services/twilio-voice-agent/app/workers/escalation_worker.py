"""
EscalationWorker — records an escalation and optionally notifies SUPPORT_EMAIL.

Does not call OpenAI. Uses the existing escalate_to_human tool function.
"""
from __future__ import annotations

import json
import logging
import time
from typing import TYPE_CHECKING

from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


class EscalationWorker:
    name = "escalation"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        t0 = time.monotonic()
        reason = entities.get("escalation_reason", "caller requested human agent")
        summary = entities.get("escalation_summary", "")

        try:
            from ..tools.shopify_tools import escalate_to_human
            result_json = await escalate_to_human(
                reason=reason,
                caller_phone=session.from_number,
                summary=summary,
                session=session,
            )
            result = json.loads(result_json)
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data=result,
                safe_summary=result.get(
                    "message",
                    "I've flagged this for our team. Someone will follow up shortly.",
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )
        except Exception:
            logger.exception("EscalationWorker error sid=%s", session.call_sid[:6])
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                safe_summary="I wasn't able to flag your request right now. Please call back.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
