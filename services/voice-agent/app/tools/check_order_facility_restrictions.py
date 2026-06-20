"""
Tool: check_order_facility_restrictions
Version: v2

Purpose:
    Check whether the books in a specific order are acceptable for shipment
    to a given correctional facility, given that facility's restrictions.

    Three distinct outcomes — success=True for all (the check itself ran correctly):
        all_accepted  → every book passes all facility restrictions
        needs_review  → at least one book is uncertain (unknown format or publisher)
        not_accepted  → at least one book clearly violates a restriction

    Structured restriction rules (local to this tool, keyed by facility name):
        format_only          → book.format must be in the allowed list
        publisher_whitelist  → book.publisher must be a known approved publisher
        all_blocked          → facility rejects all third-party book shipments

    Never reports "not_accepted" without a clear rule violation.
    Unknown data → UNCERTAIN → "needs_review", never "not_accepted".

    Reuses order data from get_order.MockOrderRepository (Option A — shared order objects).
    Reuses facility lookup from check_facility_approval.MockFacilityRepository.
"""
from __future__ import annotations

import logging
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from .base import BaseTool, ToolContext, ToolResult
from .check_facility_approval import MockFacilityRepository, RestrictionRule
from .get_order import MockOrderRepository
from .registry import registry

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1 — Domain models
# ─────────────────────────────────────────────────────────────────────────────

BookStatus = Literal["pass", "fail", "uncertain"]
RestrictionOutcome = Literal["all_accepted", "needs_review", "not_accepted"]


class BookCheckResult(BaseModel):
    title: str
    status: BookStatus
    reasons: list[str] = Field(default_factory=list)


class FacilityRestrictionData(BaseModel):
    outcome: RestrictionOutcome
    order_number: str
    facility_name: str
    facility_state: Optional[str] = None
    books_checked: int
    per_book: list[BookCheckResult]
    source: Literal["mock", "real"] = "mock"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 2 — Request model
# ─────────────────────────────────────────────────────────────────────────────


class CheckOrderFacilityRequest(BaseModel):
    order_number: str = Field(..., description="Order number whose books to check")
    facility_name: str = Field(..., description="Name of the correctional facility")
    state: Optional[str] = Field(None, description="Facility state — helps disambiguation")

    @field_validator("order_number")
    @classmethod
    def clean_order(cls, v: str) -> str:
        v = v.strip().lstrip("#")
        if not v:
            raise ValueError("order_number cannot be empty")
        return v

    @field_validator("facility_name")
    @classmethod
    def clean_facility(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("facility_name cannot be empty")
        return v


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4 — Business logic (pure, zero I/O)
# Rules come from check_facility_approval.MockFacilityRepository.restriction_rules()
# ─────────────────────────────────────────────────────────────────────────────

_STATUS_RANK = {"pass": 0, "uncertain": 1, "fail": 2}


def _worse(a: BookStatus, b: BookStatus) -> BookStatus:
    return a if _STATUS_RANK[a] >= _STATUS_RANK[b] else b


def _check_item(
    title: str,
    fmt: Optional[str],
    publisher: Optional[str],
    rules: list[RestrictionRule],
) -> BookCheckResult:
    """Evaluate one book against all facility rules. Never guesses."""
    worst: BookStatus = "pass"
    reasons: list[str] = []

    for rule in rules:
        if rule.rule_type == "all_blocked":
            return BookCheckResult(
                title=title,
                status="fail",
                reasons=["Facility does not accept third-party book shipments."],
            )

        if rule.rule_type == "format_only":
            if fmt is None:
                worst = _worse(worst, "uncertain")
                reasons.append("Book format unknown — cannot confirm compliance.")
            elif fmt.lower() not in [f.lower() for f in rule.allowed_formats]:
                worst = _worse(worst, "fail")
                reasons.append(
                    f"Format '{fmt}' not accepted — facility requires "
                    f"{'/'.join(rule.allowed_formats)}."
                )

        if rule.rule_type == "publisher_whitelist":
            if publisher is None:
                worst = _worse(worst, "uncertain")
                reasons.append("Publisher unknown — cannot verify approval.")
            elif publisher not in rule.approved_publishers:
                worst = _worse(worst, "uncertain")
                reasons.append(
                    f"Publisher '{publisher}' not in known approved list — may need verification."
                )

    return BookCheckResult(title=title, status=worst, reasons=reasons)


def _aggregate(results: list[BookCheckResult]) -> RestrictionOutcome:
    statuses = {r.status for r in results}
    if "fail" in statuses:
        return "not_accepted"
    if "uncertain" in statuses:
        return "needs_review"
    return "all_accepted"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 5 — Voice summary formatter (pure, zero I/O)
# ─────────────────────────────────────────────────────────────────────────────


def _format_voice_summary(data: FacilityRestrictionData) -> str:
    if data.outcome == "all_accepted":
        return (
            f"The books in order {data.order_number} appear acceptable for "
            f"{data.facility_name}. You should be good to proceed."
        )
    if data.outcome == "needs_review":
        uncertain = [b.title for b in data.per_book if b.status == "uncertain"]
        t = uncertain[0] if uncertain else "one of the books"
        return (
            f"One of the books — {t} — may need facility review before we can "
            f"confirm it's acceptable at {data.facility_name}. "
            "Would you like me to forward this to customer service?"
        )
    # not_accepted
    failed = [b.title for b in data.per_book if b.status == "fail"]
    t = failed[0] if failed else "one of the books"
    return (
        f"One of the books — {t} — may not be accepted at {data.facility_name}. "
        "I'd recommend forwarding this to our customer service team to confirm."
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 6 — MOCK LAYER
# ─────────────────────────────────────────────────────────────────────────────


class MockRestrictionChecker:
    @staticmethod
    def check(
        order_number: str,
        facility_name: str,
        state: Optional[str],
    ) -> FacilityRestrictionData:
        order = MockOrderRepository.get(order_number)
        facility = MockFacilityRepository.lookup(facility_name, None, state)

        if not order.found:
            return FacilityRestrictionData(
                outcome="needs_review",
                order_number=order_number,
                facility_name=facility.facility_name,
                facility_state=facility.state,
                books_checked=0,
                per_book=[],
                source="mock",
            )

        rules = MockFacilityRepository.restriction_rules(facility_name, state)

        if not rules:
            per_book = [
                BookCheckResult(
                    title=item.title,
                    status="uncertain",
                    reasons=["Facility not in database — restrictions unknown."],
                )
                for item in order.items
            ]
            return FacilityRestrictionData(
                outcome="needs_review",
                order_number=order_number,
                facility_name=facility.facility_name,
                facility_state=facility.state,
                books_checked=len(per_book),
                per_book=per_book,
                source="mock",
            )

        per_book = [
            _check_item(
                title=item.title,
                fmt=getattr(item, "format", None),
                publisher=getattr(item, "publisher", None),
                rules=rules,
            )
            for item in order.items
        ]

        return FacilityRestrictionData(
            outcome=_aggregate(per_book),
            order_number=order_number,
            facility_name=facility.facility_name,
            facility_state=facility.state,
            books_checked=len(per_book),
            per_book=per_book,
            source="mock",
        )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 7 — REAL PATH PLACEHOLDER
# ─────────────────────────────────────────────────────────────────────────────


class RealRestrictionClient:
    """NOT YET IMPLEMENTED. GET {internal_api_url}/facilities/restrictions"""

    def __init__(self, api_base: str, api_key: str) -> None:
        self._api_base = api_base
        self._api_key = api_key

    async def check(
        self, order_number: str, facility_name: str, state: Optional[str]
    ) -> FacilityRestrictionData:
        raise NotImplementedError(
            "RealRestrictionClient.check() is not yet implemented."
        )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 8 — Resolver
# ─────────────────────────────────────────────────────────────────────────────


async def _resolve(
    req: CheckOrderFacilityRequest,
    api_base: Optional[str],
    api_key: Optional[str],
) -> FacilityRestrictionData:
    use_real = bool(api_base and api_key)
    if use_real:
        try:
            client = RealRestrictionClient(api_base, api_key)  # type: ignore[arg-type]
            return await client.check(req.order_number, req.facility_name, req.state)
        except NotImplementedError:
            logger.warning("RealRestrictionClient not implemented — falling back to mock")
        except Exception as exc:
            logger.error("RealRestrictionClient.check() failed: %s — falling back to mock", exc)

    return MockRestrictionChecker.check(req.order_number, req.facility_name, req.state)


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 9 — Tool class
# ─────────────────────────────────────────────────────────────────────────────


class CheckOrderFacilityRestrictionsTool(BaseTool):
    name = "check_order_facility_restrictions"
    description = (
        "Check whether the books in a specific order are acceptable for shipment "
        "to a correctional facility given its restrictions. "
        "Returns all_accepted, needs_review, or not_accepted. "
        "success=True for all three — the check ran correctly. "
        "Call this after check_facility_approval confirms the facility is approved "
        "and the caller wants to verify their specific books are permitted."
    )
    parameters = {
        "type": "object",
        "properties": {
            "order_number": {
                "type": "string",
                "description": "Order number whose books to check",
            },
            "facility_name": {
                "type": "string",
                "description": "Name of the correctional facility",
            },
            "state": {
                "type": "string",
                "description": "Facility state abbreviation — helps disambiguation",
            },
        },
        "required": ["order_number", "facility_name"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        try:
            req = CheckOrderFacilityRequest(**args)
        except Exception as exc:
            return self.error_result(
                voice_summary="I need both an order number and the facility name to check restrictions.",
                error=f"Invalid input: {exc}",
            )

        try:
            api_base = getattr(context.agent_config, "internal_api_url", None)
            api_key = getattr(context.agent_config, "internal_api_key", None)
            result = await _resolve(req, api_base, api_key)
        except Exception as exc:
            logger.error(
                "check_order_facility_restrictions(%s, %r) failed: %s",
                req.order_number, req.facility_name, exc, exc_info=True,
            )
            return self.error_result(
                voice_summary=(
                    "I'm having trouble checking restrictions right now. "
                    "Let me connect you with our customer service team."
                ),
                error=f"Restriction check failed: {exc}",
            )

        voice_summary = _format_voice_summary(result)

        logger.info(
            "check_order_facility_restrictions: order=%s facility=%r outcome=%s books=%d session=%s",
            result.order_number, result.facility_name, result.outcome,
            result.books_checked, context.session_id,
        )

        return ToolResult(
            success=True,
            data={
                "success": True,
                "message": f"Order {result.order_number} at {result.facility_name}: {result.outcome}.",
                "suggested_response": voice_summary,
                "data": result.model_dump(),
                "error": None,
            },
            voice_summary=voice_summary,
            state_update={
                "conversation_state": "FACILITY_ORDER_CHECK",
                "facility_name": result.facility_name,
                "facility_state": result.facility_state,
            },
        )


# ── Self-register ─────────────────────────────────────────────────────────────

registry.register(CheckOrderFacilityRestrictionsTool())
