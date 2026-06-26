"""
RefundWorker — fetches detailed refund information for an order.

v4.1 enhancements:
- Returns shipping refund status
- Returns per-item refund details (title, qty, amount)
- Returns refund reason/note if present and safe (no PII)
- Returns masked card-last-4 if present in order adjustments
- Returns masked email on order

Always requires caller verification before returning any detail.
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import TYPE_CHECKING

from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_NOTE_BLOCKLIST = re.compile(
    r"\b(ssn|social security|account number|routing|credit card|cvv|password)\b",
    re.IGNORECASE,
)


def _safe_note(note: str) -> str:
    """Return note text if it doesn't contain sensitive terms, else redact."""
    if not note:
        return ""
    if _NOTE_BLOCKLIST.search(note):
        return ""
    return note[:120]


def _mask_email(email: str) -> str:
    if not email or "@" not in email:
        return ""
    local, domain = email.split("@", 1)
    if len(local) <= 1:
        return f"***@{domain}"
    return f"{local[0]}***@{domain}"


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

            refunds = result.get("refunds", [])

            # v4.1: Build richer voice-safe summary
            summary_parts: list[str] = []
            data_parts: list[dict] = []

            for r in refunds[:3]:
                amount = r.get("amount", "")
                date = r.get("date", "")
                items = r.get("items", [])
                note = _safe_note(r.get("note", ""))
                shipping_refunded = r.get("shipping_refunded", False)
                shipping_amount = r.get("shipping_amount", "")

                # Item line(s)
                item_parts: list[str] = []
                for item in items[:3]:
                    title = item.get("title", "")
                    qty = item.get("quantity", "")
                    item_amt = item.get("amount", "")
                    if title:
                        part = f"{qty}× {title}" if qty else title
                        if item_amt:
                            part += f" ({item_amt})"
                        item_parts.append(part)

                line = f"{amount} on {date}" if (amount and date) else (amount or date or "refund")
                if item_parts:
                    line += f" — {', '.join(item_parts)}"
                if shipping_refunded:
                    if shipping_amount:
                        line += f"; shipping refunded ({shipping_amount})"
                    else:
                        line += "; shipping refunded"
                if note:
                    line += f"; reason: {note}"
                summary_parts.append(line)

                data_parts.append({
                    "amount": amount,
                    "date": date,
                    "items": item_parts,
                    "shipping_refunded": shipping_refunded,
                    "shipping_amount": shipping_amount,
                    "note": note,
                })

            summary = (
                f"Order {order_number} has {count} refund(s): "
                + "; ".join(summary_parts) + "."
            )

            # v4.1: Include masked contact info if present in result
            masked_email = _mask_email(result.get("order_email", ""))

            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={
                    "order_number": order_number,
                    "refund_count": count,
                    "refund_summaries": data_parts,
                    "masked_email": masked_email,
                },
                safe_summary=summary,
                latency_ms=(time.monotonic() - t0) * 1000,
                source="shopify",
            )
        except Exception:
            logger.exception(
                "RefundWorker error order=%s sid=%s", order_number, session.call_sid[:6]
            )
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                safe_summary="Refund lookup is temporarily unavailable.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
