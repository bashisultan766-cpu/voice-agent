"""
EscalationWorker — records an escalation and optionally notifies SUPPORT_EMAIL (v4.8).

Does not call OpenAI. Uses the existing escalate_to_human tool function.

Supported escalation reasons:
  book_not_listed, unknown_inventory, facility_unknown, restricted_book_review,
  cancellation_review, address_update_help, repeated_call_cutoff, upset_customer,
  caller_requested_human
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

_ESCALATION_RESPONSES = {
    "book_not_listed": (
        "I do not see that book listed in our catalog. "
        "I can forward this to customer service so they can check availability for you."
    ),
    "unknown_inventory": (
        "I don't want to guess on availability. "
        "I can forward this to customer service."
    ),
    "facility_unknown": (
        "I don't want to guess. I can forward this to customer service for confirmation."
    ),
    "restricted_book_review": (
        "One of the books on the order may not be accepted by the facility. "
        "I can forward this to customer service for review."
    ),
    "cancellation_review": (
        "I don't want to give you the wrong answer. "
        "I can forward this to customer service for review."
    ),
    "address_update_help": (
        "For address updates, please email Jessica with your order number and the correct address."
    ),
    "repeated_call_cutoff": (
        "I can forward this to customer service so they can follow up if the call disconnects again."
    ),
    "upset_customer": (
        "I'm sorry for the trouble. Let me forward this to customer service for you."
    ),
}

_DEFAULT_ESCALATION_RESPONSE = (
    "I've flagged this for our team. Someone will follow up with you shortly. "
    "Is there anything else I can help you with in the meantime?"
)


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
        pre_message = _ESCALATION_RESPONSES.get(reason, "")

        try:
            from ..tools.shopify_tools import escalate_to_human
            result_json = await escalate_to_human(
                reason=reason,
                caller_phone=session.from_number,
                summary=summary,
                session=session,
            )
            result = json.loads(result_json)
            safe = (
                pre_message
                or result.get("message")
                or _DEFAULT_ESCALATION_RESPONSE
            )
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={**result, "escalation_reason": reason},
                safe_summary=safe,
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )
        except Exception:
            logger.exception("EscalationWorker error sid=%s", session.call_sid[:6])
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                safe_summary=pre_message or "I wasn't able to flag your request right now. Please call back.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
