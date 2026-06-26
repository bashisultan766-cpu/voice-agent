"""
FacilityApprovalWorker — checks whether a facility accepts books from SureShot Books.

Data source: Shopify order tags/notes/metafields on orders placed to that facility.
Never guesses approval status — returns "unknown" if data is insufficient.
Does not call OpenAI.
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import TYPE_CHECKING

from .worker_result import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

# Facility approval signals in order notes / tags
_APPROVED_TAGS = re.compile(
    r"\b(facility[_\-]?approved|approved[_\-]?facility|"
    r"ships[_\-]?to[_\-]?facility|facility[_\-]?ok)\b",
    re.IGNORECASE,
)
_REJECTED_TAGS = re.compile(
    r"\b(facility[_\-]?rejected|facility[_\-]?denied|"
    r"facility[_\-]?banned|not[_\-]?approved)\b",
    re.IGNORECASE,
)
_APPROVED_NOTE = re.compile(
    r"\b(approved (by|for) (the )?facility|facility (approved|accepted)|"
    r"cleared (by|for) facility|facility clearance)\b",
    re.IGNORECASE,
)
_REJECTED_NOTE = re.compile(
    r"\b(rejected by (the )?facility|facility (rejected|denied|returned)|"
    r"facility did not accept|returned (from|by) facility)\b",
    re.IGNORECASE,
)


def _parse_approval_from_order(order: dict) -> tuple[str, str]:
    """
    Parse facility approval status from order dict.
    Returns (status, reason) where status ∈ {"approved","rejected","unknown"}.
    """
    tags = " ".join(order.get("tags", []) if isinstance(order.get("tags"), list) else
                    [t.strip() for t in (order.get("tags") or "").split(",")])
    note = order.get("note", "") or ""
    attrs = {a.get("key", ""): a.get("value", "")
             for a in order.get("customAttributes", []) or []}
    attr_text = " ".join(attrs.values())

    combined = f"{tags} {note} {attr_text}"

    if _APPROVED_TAGS.search(tags) or _APPROVED_NOTE.search(note):
        return ("approved", "Based on prior order records, this facility accepts our books.")
    if _REJECTED_TAGS.search(tags) or _REJECTED_NOTE.search(note):
        return ("rejected", "Based on prior order records, this facility has rejected our shipments.")

    # Check attributes explicitly
    facility_status = attrs.get("facility_approval_status", "").lower()
    if facility_status in ("approved", "accepted", "ok"):
        return ("approved", f"Facility status on file: {facility_status}.")
    if facility_status in ("rejected", "denied", "banned"):
        return ("rejected", f"Facility status on file: {facility_status}.")

    return ("unknown", "")


class FacilityApprovalWorker:
    name = "facility_approval"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        t0 = time.monotonic()
        facility_name = (
            entities.get("facility_name")
            or getattr(session, "last_facility_name", "")
        )

        if not facility_name:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_facility",
                safe_summary=(
                    "Which facility are you shipping to? "
                    "I can check if we ship there."
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )

        # Update session facility context
        if facility_name:
            session.last_facility_name = facility_name

        # Look for recent orders to/for this facility
        order_number = entities.get("order_number") or session.last_order_number
        approval_status = "unknown"
        reason = ""

        if order_number:
            try:
                from ..tools.shopify_tools import lookup_order, order_record_from_lookup
                result_json = await lookup_order(
                    order_number=order_number,
                    email=None,
                    phone=None,
                    session=session,
                )
                result = json.loads(result_json)
                order = order_record_from_lookup(result)
                if order:
                    approval_status, reason = _parse_approval_from_order(order)
            except Exception:
                logger.warning(
                    "FacilityApprovalWorker order lookup failed sid=%s",
                    session.call_sid[:6],
                )

        # v4.8: check the approved list CSV first
        if approval_status == "unknown":
            try:
                from ..facility.approved_list import lookup_facility
                city = (
                    entities.get("facility_city")
                    or getattr(session, "last_facility_city", "")
                )
                state_val = (
                    entities.get("facility_state")
                    or getattr(session, "last_facility_state", "")
                )
                list_result = lookup_facility(facility_name, city=city, state=state_val)
                if list_result.found:
                    if list_result.approved:
                        approval_status = "approved"
                        reason = "Listed in the approved facility database."
                    else:
                        approval_status = "rejected"
                        reason = "Not listed as approved in the facility database."
            except Exception:
                logger.warning(
                    "FacilityApprovalWorker CSV lookup failed sid=%s", session.call_sid[:6]
                )

        if approval_status == "approved":
            if facility_name:
                safe_summary = (
                    f"Yes, SureShot Books is approved to ship to {facility_name}."
                )
            else:
                safe_summary = (
                    "Yes, SureShot Books is approved to ship to that facility."
                )
        elif approval_status == "rejected":
            safe_summary = "I do not see that facility as approved for shipping."
        else:
            safe_summary = (
                "I don't want to guess. I can forward this to customer service for confirmation."
            )

        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={
                "facility_name": facility_name,
                "approval_status": approval_status,
                "reason": reason,
            },
            safe_summary=safe_summary,
            latency_ms=(time.monotonic() - t0) * 1000,
            source="shopify" if order_number and approval_status != "unknown" else "local",
        )
