"""
Tool: check_facility_approval
Version: v2

Purpose:
    Look up whether a correctional facility is approved to receive book
    shipments from SureShot Books, and what restrictions apply.

    Three distinct outcomes — machine-distinguishable via `approved`:
        approved=True   → facility known and approved
        approved=False  → facility known and NOT approved
        approved=None   → facility not in database (unknown — never guess)

    success=True for all three outcomes: the lookup ran correctly.
    The agent must never report "not approved" for an unknown facility.

    suggested_response wording:
        approved     → "Yes, SureShot Books is approved to ship to that facility."
        not_approved → "I don't see that facility as approved for shipping."
        unknown      → "I don't want to guess. I can forward this to customer
                        service for confirmation."

    Two-layer architecture:
        MOCK: MockFacilityRepository  (active — 3-entry table, one per outcome)
        REAL: RealFacilityClient      (disabled — GET {internal_api_url}/facilities/approval)
"""
from __future__ import annotations

import logging
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1 — Domain models
# ─────────────────────────────────────────────────────────────────────────────

ApprovalStatus = Literal["approved", "not_approved", "unknown"]


class FacilityRecord(BaseModel):
    """One row in the facility database."""

    facility_name: str
    city: Optional[str] = None
    state: Optional[str] = None
    approved: bool
    restrictions: list[str] = Field(default_factory=list)
    notes: str = ""


class FacilityApprovalData(BaseModel):
    facility_name: str
    city: Optional[str] = None
    state: Optional[str] = None
    approved: Optional[bool]            # True / False / None (unknown)
    approval_status: ApprovalStatus     # "approved" / "not_approved" / "unknown"
    restrictions: list[str] = Field(default_factory=list)
    source: Literal["mock", "real"] = "mock"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 2 — Request model
# ─────────────────────────────────────────────────────────────────────────────


class CheckFacilityApprovalRequest(BaseModel):
    facility_name: str = Field(..., description="Name of the correctional facility")
    city: Optional[str] = Field(None, description="City — helps disambiguate common names")
    state: Optional[str] = Field(None, description="US state (abbreviation or full name)")

    @field_validator("facility_name")
    @classmethod
    def clean_facility_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("facility_name cannot be empty")
        return v

    @field_validator("city", "state")
    @classmethod
    def clean_optional(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        return v or None


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 3 — Business logic (pure, zero I/O)
# ─────────────────────────────────────────────────────────────────────────────


def _norm(s: str) -> str:
    return s.lower().strip()


def _facility_matches(
    record: FacilityRecord,
    name: str,
    state: Optional[str],
) -> bool:
    """
    Name: query substring of record OR record substring of query.
    State: if caller provided one, it must also match (first two chars suffice).
    """
    q_name = _norm(name)
    r_name = _norm(record.facility_name)
    if q_name not in r_name and r_name not in q_name:
        return False
    if state and record.state:
        q_state = _norm(state)[:2]
        r_state = _norm(record.state)[:2]
        if q_state != r_state:
            return False
    return True


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4 — Voice summary formatter (pure, zero I/O)
# ─────────────────────────────────────────────────────────────────────────────


def _format_voice_summary(data: FacilityApprovalData) -> str:
    if data.approval_status == "approved":
        restriction_note = ""
        if data.restrictions:
            restriction_note = f" They accept {data.restrictions[0].lower()}."
        return (
            f"Yes, SureShot Books is approved to ship to {data.facility_name}."
            f"{restriction_note}"
            " Would you like to go ahead and place your order?"
        )

    if data.approval_status == "not_approved":
        return (
            f"I don't see {data.facility_name} as approved for shipping. "
            "I'd recommend checking with our customer service team for options."
        )

    # unknown — never guess
    return (
        "I don't want to guess. "
        "I can forward this to customer service for confirmation. "
        "Would you like me to do that?"
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 5 — MOCK LAYER
#
# One entry per outcome:
#   Rikers Island Correctional Facility  (NY)  → approved=True
#   Cook County Jail                     (IL)  → approved=False
#   Anything else                              → unknown (approved=None)
# ─────────────────────────────────────────────────────────────────────────────

_MOCK_FACILITIES: list[FacilityRecord] = [
    FacilityRecord(
        facility_name="Rikers Island Correctional Facility",
        city="East Elmhurst",
        state="NY",
        approved=True,
        restrictions=["Paperback books only", "Publisher must be on approved list"],
        notes="Ships via USPS Media Mail only",
    ),
    FacilityRecord(
        facility_name="Cook County Jail",
        city="Chicago",
        state="IL",
        approved=False,
        restrictions=[],
        notes="Facility does not accept third-party book shipments",
    ),
]


class MockFacilityRepository:
    @staticmethod
    def lookup(
        facility_name: str,
        city: Optional[str],
        state: Optional[str],
    ) -> FacilityApprovalData:
        for record in _MOCK_FACILITIES:
            if _facility_matches(record, facility_name, state):
                status: ApprovalStatus = "approved" if record.approved else "not_approved"
                return FacilityApprovalData(
                    facility_name=record.facility_name,
                    city=record.city,
                    state=record.state,
                    approved=record.approved,
                    approval_status=status,
                    restrictions=record.restrictions,
                    source="mock",
                )

        # Not in table — return unknown, not "not_approved"
        return FacilityApprovalData(
            facility_name=facility_name,
            city=city,
            state=state,
            approved=None,
            approval_status="unknown",
            restrictions=[],
            source="mock",
        )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 6 — REAL PATH PLACEHOLDER (disabled — interface contract only)
# ─────────────────────────────────────────────────────────────────────────────


class RealFacilityClient:
    """
    Interface contract for the live facility approval database. NOT YET IMPLEMENTED.
    Real path: GET {internal_api_url}/facilities/approval?name=...&state=...
    Response must be mapped to FacilityApprovalData with approved=None for unknown.
    """

    def __init__(self, api_base: str, api_key: str) -> None:
        self._api_base = api_base
        self._api_key = api_key

    async def lookup(
        self,
        facility_name: str,
        city: Optional[str],
        state: Optional[str],
    ) -> FacilityApprovalData:
        raise NotImplementedError(
            "RealFacilityClient.lookup() is not yet implemented. "
            "Set internal_api_url + internal_api_key to activate real mode."
        )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 7 — Resolver
# ─────────────────────────────────────────────────────────────────────────────


async def _resolve_facility_approval(
    req: CheckFacilityApprovalRequest,
    api_base: Optional[str],
    api_key: Optional[str],
) -> FacilityApprovalData:
    use_real = bool(api_base and api_key)

    if use_real:
        try:
            client = RealFacilityClient(api_base, api_key)  # type: ignore[arg-type]
            return await client.lookup(req.facility_name, req.city, req.state)
        except NotImplementedError:
            logger.warning("RealFacilityClient not implemented — falling back to mock")
        except Exception as exc:
            logger.error(
                "RealFacilityClient.lookup(%r) failed: %s — falling back to mock",
                req.facility_name, exc,
            )

    logger.debug("check_facility_approval: using mock data for %r", req.facility_name)
    return MockFacilityRepository.lookup(req.facility_name, req.city, req.state)


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 8 — Tool class
# ─────────────────────────────────────────────────────────────────────────────


class CheckFacilityApprovalTool(BaseTool):
    name = "check_facility_approval"
    description = (
        "Check whether a correctional facility is approved to receive book shipments "
        "from SureShot Books, and what restrictions apply. "
        "Returns approved=true (approved), approved=false (not approved), "
        "or approved=null (unknown — never guess). "
        "Call this whenever the caller mentions a prison, jail, or correctional facility."
    )
    parameters = {
        "type": "object",
        "properties": {
            "facility_name": {
                "type": "string",
                "description": "Full name of the correctional facility",
            },
            "city": {
                "type": "string",
                "description": "City — include to disambiguate facilities with common names",
            },
            "state": {
                "type": "string",
                "description": "US state abbreviation (e.g. 'NY') or full name",
            },
        },
        "required": ["facility_name"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        try:
            req = CheckFacilityApprovalRequest(**args)
        except Exception as exc:
            return self.error_result(
                voice_summary="Which facility are you shipping to?",
                error=f"Invalid input: {exc}",
            )

        try:
            api_base = getattr(context.agent_config, "internal_api_url", None)
            api_key = getattr(context.agent_config, "internal_api_key", None)
            result = await _resolve_facility_approval(req, api_base, api_key)
        except Exception as exc:
            logger.error(
                "check_facility_approval(%r) failed: %s",
                req.facility_name, exc, exc_info=True,
            )
            return self.error_result(
                voice_summary=(
                    "I'm having trouble looking up that facility right now. "
                    "Let me connect you with our customer service team."
                ),
                error=f"Facility lookup failed: {exc}",
            )

        voice_summary = _format_voice_summary(result)

        status_label = {
            "approved": "Approved",
            "not_approved": "Not approved",
            "unknown": "Unknown — forwarding to CS",
        }[result.approval_status]

        logger.info(
            "check_facility_approval: facility=%r state=%s status=%s source=%s session=%s",
            result.facility_name, result.state, result.approval_status,
            result.source, context.session_id,
        )

        return ToolResult(
            success=True,
            data={
                "success": True,
                "message": f"Facility lookup: {result.facility_name} — {status_label}.",
                "suggested_response": voice_summary,
                "data": result.model_dump(),
                "error": None,
            },
            voice_summary=voice_summary,
            state_update={
                "conversation_state": "FACILITY_APPROVAL",
                "facility_name": result.facility_name,
                "facility_state": result.state,
                "facility_approval_status": result.approval_status,
            },
        )


# ── Self-register ─────────────────────────────────────────────────────────────

registry.register(CheckFacilityApprovalTool())
