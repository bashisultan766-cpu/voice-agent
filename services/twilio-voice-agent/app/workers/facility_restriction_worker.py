"""
FacilityRestrictionWorker — returns book restrictions for a correctional facility.

Data source: Shopify order notes, tags, and metafields.
Never guesses restrictions — returns what is on record only.
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

# Common restriction keywords in notes/tags
_HARDCOVER_BAN = re.compile(
    r"\b(no hardcover|hardcover (not allowed|banned|prohibited|rejected)|"
    r"softcover only|paperback only)\b",
    re.IGNORECASE,
)
_USED_BAN = re.compile(
    r"\b(no used books?|new (books? )?only|only new books?)\b",
    re.IGNORECASE,
)
_PUBLISHER_RESTRICT = re.compile(
    r"\b(approved publisher|publisher (list|approval|restriction)|"
    r"only (from )?approved publishers?)\b",
    re.IGNORECASE,
)


def _parse_restrictions(order: dict) -> list[str]:
    """Extract human-readable restriction notes from an order record."""
    restrictions: list[str] = []

    note = order.get("note", "") or ""
    tags_raw = order.get("tags", "")
    tags = tags_raw if isinstance(tags_raw, list) else [t.strip() for t in tags_raw.split(",")]
    attrs = {a.get("key", ""): a.get("value", "")
             for a in order.get("customAttributes", []) or []}

    combined = f"{' '.join(tags)} {note} {' '.join(attrs.values())}"

    if _HARDCOVER_BAN.search(combined):
        restrictions.append("No hardcover books — softcover/paperback only.")
    if _USED_BAN.search(combined):
        restrictions.append("New books only — no used copies.")
    if _PUBLISHER_RESTRICT.search(combined):
        restrictions.append("Only books from the facility's approved publisher list.")

    # Check attribute for explicit restriction field
    restriction_note = attrs.get("facility_restrictions", "")
    if restriction_note and len(restriction_note) <= 200:
        restrictions.append(restriction_note)

    return restrictions


class FacilityRestrictionWorker:
    name = "facility_restriction"

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
                    "Which facility would you like book restrictions for? "
                    "Please give me the facility name."
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )

        if facility_name:
            session.last_facility_name = facility_name

        order_number = entities.get("order_number") or session.last_order_number
        restrictions: list[str] = []

        if order_number:
            try:
                from ..tools.shopify_tools import lookup_order
                result_json = await lookup_order(
                    order_number=order_number,
                    email=None,
                    phone=session.from_number if getattr(session, "from_number", "") else None,
                    session=session,
                )
                result = json.loads(result_json)
                if result.get("found"):
                    restrictions = _parse_restrictions({
                        "note": result.get("note", ""),
                        "tags": result.get("tags", []),
                        "customAttributes": [
                            {"key": k, "value": v}
                            for k, v in (result.get("custom_attributes") or {}).items()
                        ],
                    })
            except Exception:
                logger.warning(
                    "FacilityRestrictionWorker lookup failed sid=%s", session.call_sid[:6]
                )

        order_books: list[str] = []
        if order_number:
            try:
                from ..tools.shopify_tools import lookup_order
                result_json2 = await lookup_order(
                    order_number=order_number,
                    email=None,
                    phone=session.from_number if getattr(session, "from_number", "") else None,
                    session=session,
                )
                result2 = json.loads(result_json2)
                if result2.get("found") and result2.get("items"):
                    for item_str in result2["items"]:
                        parts = item_str.split("x ", 1)
                        if len(parts) == 2:
                            order_books.append(parts[1].strip())
            except Exception:
                pass

        if order_books:
            try:
                from ..facility.restrictions import check_order_restrictions
                check_result = check_order_restrictions(order_books, facility_name)
                if check_result["all_clear"]:
                    safe_summary = check_result["safe_response"]
                elif check_result["restricted"]:
                    safe_summary = check_result["safe_response"]
                else:
                    safe_summary = check_result["safe_response"]
            except Exception:
                if restrictions:
                    restriction_text = " ".join(restrictions)
                    safe_summary = f"Known restrictions for {facility_name}: {restriction_text}"
                else:
                    safe_summary = (
                        "I don't want to guess. I can forward this to customer service for review."
                    )
        elif restrictions:
            restriction_text = " ".join(restrictions)
            safe_summary = f"Known restrictions for {facility_name}: {restriction_text}"
        else:
            safe_summary = (
                f"I don't have specific restriction information on file for {facility_name}. "
                "Common restrictions at many facilities include: no hardcover books, "
                "new books only, and books must ship directly from the retailer. "
                "I'd recommend calling the facility to confirm their current rules."
            )

        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={
                "facility_name": facility_name,
                "restrictions": restrictions,
            },
            safe_summary=safe_summary,
            latency_ms=(time.monotonic() - t0) * 1000,
            source="shopify" if (order_number and restrictions) else "local",
        )
