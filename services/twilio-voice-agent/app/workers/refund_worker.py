"""
RefundWorker — fetches refund details for an order.

Always requires caller verification (email or phone) before returning
detailed refund data. Unverified calls return a verification prompt.
Calls Shopify get_refund_status on miss.
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


class RefundWorker:
    name = "refund"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        order_number = entities.get("order_number") or session.last_order_number
        if not order_number:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_order_number",
                source="none",
            )

        t0 = time.monotonic()
        verified = session.verified_email or session.verified_phone

        if not verified:
            # Return early with verification required — do not hit Shopify.
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"order_number": order_number, "verified": False},
                safe_summary=(
                    "To share refund details, I'll need to verify your identity. "
                    "Could you give me the email address on your account?"
                ),
                requires_verification=True,
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )

        try:
            email = session.caller_email if session.verified_email else None
            phone = session.from_number if session.verified_phone else None

            from ..tools.shopify_tools import get_refund_status
            result_json = await get_refund_status(
                order_number=order_number,
                email=email,
                phone=phone,
                session=session,
            )
            result = json.loads(result_json)

            if not result.get("found"):
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data=result,
                    safe_summary=f"No order found matching {order_number}.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="shopify",
                )

            count = result.get("refund_count", 0)
            if count == 0:
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={"order_number": order_number, "refund_count": 0},
                    safe_summary=f"No refunds have been issued for order {order_number}.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="shopify",
                )

            # Build voice-safe summary — amounts and dates only, no GIDs/txn IDs.
            refunds = result.get("refunds", [])
            parts = []
            for r in refunds[:3]:  # limit verbosity
                parts.append(f"{r.get('amount', '?')} on {r.get('date', '?')}")
            summary = (
                f"Order {order_number} has {count} refund(s): "
                + "; ".join(parts) + "."
            )
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={
                    "order_number": order_number,
                    "refund_count": count,
                    "refund_summaries": [
                        {"amount": r.get("amount"), "date": r.get("date")}
                        for r in refunds[:3]
                    ],
                },
                safe_summary=summary,
                latency_ms=(time.monotonic() - t0) * 1000,
                source="shopify",
            )
        except Exception:
            logger.exception("RefundWorker error order=%s sid=%s", order_number, session.call_sid[:6])
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                safe_summary="Refund lookup is temporarily unavailable.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
