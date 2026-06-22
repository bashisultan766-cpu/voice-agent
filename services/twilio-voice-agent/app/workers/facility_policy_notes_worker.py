"""
FacilityPolicyNotesWorker — returns general facility shipping policy notes.

Pulls from Shopify order notes, tags, and custom attributes.
Provides common SureShot Books facility policy guidance as a fallback.
Does not call OpenAI.
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

_DEFAULT_POLICY = (
    "At SureShot Books, all books are shipped directly from our warehouse to the facility — "
    "we never ship to the buyer's home for inmate orders. "
    "Books must be new, paperback unless the facility accepts hardcover, "
    "and should meet the facility's content guidelines. "
    "Include the inmate's full name and ID number exactly as the facility requires."
)


class FacilityPolicyNotesWorker:
    name = "facility_policy_notes"

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

        # Try to pull facility-specific notes from a recent order
        order_number = entities.get("order_number") or session.last_order_number
        policy_notes: list[str] = []

        if order_number:
            try:
                from ..tools.shopify_tools import lookup_order
                result_json = await lookup_order(
                    order_number=order_number,
                    email=None,
                    phone=None,
                    session=session,
                )
                result = json.loads(result_json)
                if result.get("found") and result.get("orders"):
                    order = result["orders"][0]
                    note = (order.get("note") or "").strip()
                    if note and len(note) <= 300:
                        policy_notes.append(note)
                    attrs = {a.get("key", ""): a.get("value", "")
                             for a in order.get("customAttributes", []) or []}
                    policy_note = attrs.get("facility_policy", "")
                    if policy_note and len(policy_note) <= 300:
                        policy_notes.append(policy_note)
            except Exception:
                logger.warning(
                    "FacilityPolicyNotesWorker lookup failed sid=%s", session.call_sid[:6]
                )

        if policy_notes:
            facility_label = f" for {facility_name}" if facility_name else ""
            safe_summary = f"Policy notes{facility_label}: " + " ".join(policy_notes)
        else:
            prefix = f"For {facility_name}: " if facility_name else ""
            safe_summary = prefix + _DEFAULT_POLICY

        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={
                "facility_name": facility_name or "",
                "policy_notes": policy_notes,
                "default_used": not bool(policy_notes),
            },
            safe_summary=safe_summary,
            latency_ms=(time.monotonic() - t0) * 1000,
            source="shopify" if policy_notes else "local",
        )
