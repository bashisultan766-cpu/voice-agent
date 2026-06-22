"""
OrderFacilityReviewWorker — reviews an existing order for facility-related issues.

Checks: facility rejection tags, return notes, approval status.
Requires caller verification before revealing order details.
Does not call OpenAI.
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

_RETURN_TAGS = re.compile(
    r"\b(facility[_\-]?returned|returned[_\-]?by[_\-]?facility|"
    r"facility[_\-]?rejected|rejected[_\-]?by[_\-]?facility)\b",
    re.IGNORECASE,
)
_RETURN_NOTE = re.compile(
    r"\b(returned (from|by) (the )?facility|facility (returned|rejected|refused)|"
    r"sent back (from|by) facility)\b",
    re.IGNORECASE,
)


def _check_facility_issues(order: dict) -> dict:
    """Return dict with any facility-related issues found on the order."""
    tags_raw = order.get("tags", "")
    tags = tags_raw if isinstance(tags_raw, list) else [t.strip() for t in tags_raw.split(",")]
    note = order.get("note", "") or ""
    attrs = {a.get("key", ""): a.get("value", "")
             for a in order.get("customAttributes", []) or []}

    tag_str = " ".join(tags)
    issues: dict = {}

    if _RETURN_TAGS.search(tag_str) or _RETURN_NOTE.search(note):
        issues["returned_by_facility"] = True
        return_reason = attrs.get("facility_return_reason", "")
        if return_reason:
            issues["return_reason"] = return_reason[:120]

    facility_status = attrs.get("facility_approval_status", "").lower()
    if facility_status:
        issues["facility_approval_status"] = facility_status

    return issues


class OrderFacilityReviewWorker:
    name = "order_facility_review"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        t0 = time.monotonic()
        order_number = entities.get("order_number") or session.last_order_number

        if not order_number:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_order_number",
                safe_summary="I need an order number to check facility status.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )

        verified = session.verified_email or session.verified_phone
        if not verified:
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"order_number": order_number, "verified": False},
                safe_summary=(
                    "To check facility details on your order, I need to verify your identity. "
                    "Could you give me the email address on the order?"
                ),
                requires_verification=True,
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )

        try:
            email = session.caller_email if session.verified_email else None
            phone = session.from_number if session.verified_phone else None

            from ..tools.shopify_tools import lookup_order
            result_json = await lookup_order(
                order_number=order_number,
                email=email,
                phone=phone,
                session=session,
            )
            result = json.loads(result_json)

            if not result.get("found") or not result.get("orders"):
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={"order_number": order_number, "found": False},
                    safe_summary=f"No order found matching {order_number}.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="shopify",
                )

            order = result["orders"][0]
            issues = _check_facility_issues(order)

            if not issues:
                safe_summary = (
                    f"Order {order_number} has no facility flags on record — "
                    "no returns or rejections noted."
                )
            elif issues.get("returned_by_facility"):
                reason = issues.get("return_reason", "")
                safe_summary = (
                    f"Order {order_number} was returned by the facility."
                    + (f" Reason on file: {reason}" if reason else "")
                    + " Please contact us to arrange a replacement or refund."
                )
            else:
                status = issues.get("facility_approval_status", "")
                safe_summary = f"Order {order_number} facility status: {status or 'pending'}."

            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"order_number": order_number, "issues": issues},
                safe_summary=safe_summary,
                latency_ms=(time.monotonic() - t0) * 1000,
                source="shopify",
            )

        except Exception:
            logger.exception(
                "OrderFacilityReviewWorker error order=%s sid=%s",
                order_number,
                session.call_sid[:6],
            )
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                safe_summary="Facility review is temporarily unavailable.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
