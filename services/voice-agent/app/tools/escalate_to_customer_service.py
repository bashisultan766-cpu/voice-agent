"""
Tool: escalate_to_customer_service
Version: v2

Purpose:
    Flag the current call for follow-up by the SureShot Books customer service team.
    Logs the reason, optional order reference, and caller phone.

    success=True only when the escalation is actually logged (mock stub always succeeds;
    real path must return a confirmed ticket ID from the backend).

    Two-layer architecture:
        MOCK: _escalation_stub()   (active — logs to console, returns ticket ID)
        REAL: RealEscalationClient (disabled — POST {internal_api_url}/escalations)
"""
from __future__ import annotations

import logging
import secrets
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1 — Domain models
# ─────────────────────────────────────────────────────────────────────────────


class EscalationData(BaseModel):
    ticket_id: str
    reason: str
    order_number: Optional[str] = None
    caller_phone: Optional[str] = None
    escalated: bool
    mode: Literal["stub", "real"] = "stub"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 2 — Request model
# ─────────────────────────────────────────────────────────────────────────────


class EscalateRequest(BaseModel):
    reason: str = Field(..., description="Why escalation is needed")
    order_number: Optional[str] = Field(None, description="Related order number — optional")
    notes: Optional[str] = Field(None, max_length=500, description="Additional context")

    @field_validator("reason")
    @classmethod
    def clean_reason(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("reason cannot be empty")
        return v

    @field_validator("order_number")
    @classmethod
    def clean_order(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        return v.strip().lstrip("#") or None


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 3 — Voice summary formatter (pure, zero I/O)
# ─────────────────────────────────────────────────────────────────────────────


def _format_voice_summary(data: EscalationData) -> str:
    if data.escalated:
        return (
            "I've flagged this for our customer service team. "
            f"Your escalation reference is {data.ticket_id}. "
            "Someone will follow up with you shortly."
        )
    return (
        "I wasn't able to reach our customer service team right now. "
        "Please call back and we'll make sure someone assists you."
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4 — STUB / MOCK LAYER
# ─────────────────────────────────────────────────────────────────────────────


async def _escalation_stub(
    reason: str,
    order_number: Optional[str],
    caller_phone: Optional[str],
    notes: Optional[str],
) -> EscalationData:
    ticket_id = f"ESC-{secrets.token_hex(3).upper()}"
    logger.info(
        "[ESCALATION STUB] ticket=%s reason=%r order=%s phone=%s notes=%r",
        ticket_id, reason, order_number or "n/a", caller_phone or "n/a", notes,
    )
    return EscalationData(
        ticket_id=ticket_id,
        reason=reason,
        order_number=order_number,
        caller_phone=caller_phone,
        escalated=True,
        mode="stub",
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 5 — REAL PATH PLACEHOLDER
# ─────────────────────────────────────────────────────────────────────────────


class RealEscalationClient:
    """NOT YET IMPLEMENTED. POST {internal_api_url}/escalations"""

    def __init__(self, api_base: str, api_key: str) -> None:
        self._api_base = api_base
        self._api_key = api_key

    async def escalate(
        self,
        reason: str,
        order_number: Optional[str],
        caller_phone: Optional[str],
        notes: Optional[str],
    ) -> EscalationData:
        raise NotImplementedError(
            "RealEscalationClient.escalate() is not yet implemented. "
            "Set internal_api_url + internal_api_key to activate real mode."
        )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 6 — Resolver
# ─────────────────────────────────────────────────────────────────────────────


async def _resolve_escalation(
    req: EscalateRequest,
    caller_phone: Optional[str],
    api_base: Optional[str],
    api_key: Optional[str],
) -> EscalationData:
    use_real = bool(api_base and api_key)
    if use_real:
        try:
            client = RealEscalationClient(api_base, api_key)  # type: ignore[arg-type]
            return await client.escalate(req.reason, req.order_number, caller_phone, req.notes)
        except NotImplementedError:
            logger.warning("RealEscalationClient not implemented — falling back to stub")
        except Exception as exc:
            logger.error("RealEscalationClient.escalate() failed: %s — falling back to stub", exc)

    return await _escalation_stub(req.reason, req.order_number, caller_phone, req.notes)


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 7 — Tool class
# ─────────────────────────────────────────────────────────────────────────────


class EscalateToCustomerServiceTool(BaseTool):
    name = "escalate_to_customer_service"
    description = (
        "Flag the current call for follow-up by the SureShot Books customer service team. "
        "Logs the reason and optional order reference. "
        "Call this when the caller's request cannot be resolved by voice tools, "
        "when they ask to speak to a person, or when a tool returns requires_cs."
    )
    parameters = {
        "type": "object",
        "properties": {
            "reason": {
                "type": "string",
                "description": "Brief description of why escalation is needed",
            },
            "order_number": {
                "type": "string",
                "description": "Related order number — optional",
            },
            "notes": {
                "type": "string",
                "description": "Additional context for the CS team — optional",
            },
        },
        "required": ["reason"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        try:
            req = EscalateRequest(**args)
        except Exception as exc:
            return self.error_result(
                voice_summary="Let me connect you with our customer service team.",
                error=f"Invalid input: {exc}",
            )

        caller_phone: Optional[str] = getattr(context, "from_number", None)

        try:
            api_base = getattr(context.agent_config, "internal_api_url", None)
            api_key = getattr(context.agent_config, "internal_api_key", None)
            result = await _resolve_escalation(req, caller_phone, api_base, api_key)
        except Exception as exc:
            logger.error(
                "escalate_to_customer_service failed: %s session=%s", exc, context.session_id, exc_info=True
            )
            return self.error_result(
                voice_summary=(
                    "I wasn't able to reach our customer service team right now. "
                    "Please call back and we'll make sure someone assists you."
                ),
                error=f"Escalation failed: {exc}",
            )

        voice_summary = _format_voice_summary(result)

        logger.info(
            "escalate_to_customer_service: ticket=%s reason=%r escalated=%s mode=%s session=%s",
            result.ticket_id, result.reason, result.escalated, result.mode, context.session_id,
        )

        if not result.escalated:
            return ToolResult(
                success=False,
                data={
                    "success": False,
                    "message": "Escalation failed to log.",
                    "suggested_response": voice_summary,
                    "data": result.model_dump(),
                    "error": "escalated is False",
                },
                voice_summary=voice_summary,
                error="escalated is False",
            )

        return ToolResult(
            success=True,
            data={
                "success": True,
                "message": f"Escalation logged: ticket {result.ticket_id}.",
                "suggested_response": voice_summary,
                "data": result.model_dump(),
                "error": None,
            },
            voice_summary=voice_summary,
            state_update={"conversation_state": "ESCALATED"},
        )


# ── Self-register ─────────────────────────────────────────────────────────────

registry.register(EscalateToCustomerServiceTool())
