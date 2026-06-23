"""
SmallTalkWorker — deterministic Eric persona responses (v4.9).
"""
from __future__ import annotations

import time
from typing import TYPE_CHECKING

from ..brain.eric_policy import get_small_talk_response
from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState


class SmallTalkWorker:
    name = "small_talk"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
        worker_bundle=None,
    ) -> WorkerResult:
        t0 = time.monotonic()
        intent = entities.get("intent", "small_talk")
        from ..agent_runtime.action_gate import is_name_question
        from ..agent_runtime.eric_master_policy import get_deterministic_template

        if intent in ("identity_question", "agent_name_question", "name_question") or (
            entities.get("query") and is_name_question(entities.get("query", ""))
        ):
            text = get_deterministic_template("identity_name") or (
                "My name is Eric. I'm with SureShot Books."
            )
        else:
            text = get_small_talk_response(intent, session) or (
                "I'm here to help. What can I do for you today?"
            )

        # Mark resume greeting delivered after first small-talk response
        if getattr(session, "resume_greeting_pending", False):
            session.resume_greeting_delivered = True
            session.resume_greeting_pending = False

        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={"intent": intent, "response": text},
            safe_summary=text,
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
