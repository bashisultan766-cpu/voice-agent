"""
Tool: address_update_instructions
Version: v2

Purpose:
    Return the SureShot Books address-update procedure to the caller.
    Address changes CANNOT be made by voice — the caller must email
    customer service with their order number and new address.

    No external API call needed — this returns static procedure text.
    Optional order_number personalises the instruction.
    cs_email is pulled from agent_config.cs_email (falls back to generic text).
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator

from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1 — Domain models
# ─────────────────────────────────────────────────────────────────────────────


class AddressUpdateData(BaseModel):
    instruction: str
    cs_email: Optional[str] = None
    order_number: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 2 — Request model
# ─────────────────────────────────────────────────────────────────────────────


class AddressUpdateRequest(BaseModel):
    order_number: Optional[str] = Field(
        None,
        description="Order number to include in the instruction — optional but helpful",
    )

    @field_validator("order_number")
    @classmethod
    def clean(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip().lstrip("#")
        return v or None


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 3 — Business logic (pure, zero I/O)
# ─────────────────────────────────────────────────────────────────────────────


def _build_instruction(cs_email: Optional[str], order_number: Optional[str]) -> AddressUpdateData:
    if cs_email:
        if order_number:
            instruction = (
                f"To update the shipping address for order {order_number}, "
                f"please email Jessica at {cs_email} with your order number and your new address. "
                "We'll update it within one business day."
            )
        else:
            instruction = (
                f"To update a shipping address, please email Jessica at {cs_email} "
                "with your order number and your new address. "
                "We'll update it within one business day."
            )
    else:
        if order_number:
            instruction = (
                f"To update the shipping address for order {order_number}, "
                "please contact our customer service team with your order number "
                "and your new address, and we'll update it within one business day."
            )
        else:
            instruction = (
                "To update a shipping address, please contact our customer service team "
                "with your order number and your new address. "
                "We'll update it within one business day."
            )
    return AddressUpdateData(
        instruction=instruction,
        cs_email=cs_email or None,
        order_number=order_number,
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4 — Voice summary formatter (pure, zero I/O)
# ─────────────────────────────────────────────────────────────────────────────


def _format_voice_summary(data: AddressUpdateData) -> str:
    return data.instruction


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 5 — Tool class
# (No mock/real split — returns static procedure text, no external calls)
# ─────────────────────────────────────────────────────────────────────────────


class AddressUpdateInstructionsTool(BaseTool):
    name = "address_update_instructions"
    description = (
        "Return the SureShot Books address-update procedure. "
        "Address changes cannot be made by voice — the caller must email "
        "customer service with their order number and new address. "
        "Call this when the caller asks to change or update a shipping address."
    )
    parameters = {
        "type": "object",
        "properties": {
            "order_number": {
                "type": "string",
                "description": "Order number to reference in the instructions — optional",
            },
        },
        "required": [],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        try:
            req = AddressUpdateRequest(**args)
        except Exception as exc:
            return self.error_result(
                voice_summary="Let me give you the address update instructions.",
                error=f"Invalid input: {exc}",
            )

        cs_email: Optional[str] = getattr(context.agent_config, "cs_email", None) or None
        result = _build_instruction(cs_email, req.order_number)
        voice_summary = _format_voice_summary(result)

        logger.info(
            "address_update_instructions: order=%s cs_email_set=%s session=%s",
            req.order_number, bool(cs_email), context.session_id,
        )

        return ToolResult(
            success=True,
            data={
                "success": True,
                "message": "Address update instructions returned.",
                "suggested_response": voice_summary,
                "data": result.model_dump(),
                "error": None,
            },
            voice_summary=voice_summary,
            state_update={"conversation_state": "ADDRESS_UPDATE"},
        )


# ── Self-register ─────────────────────────────────────────────────────────────

registry.register(AddressUpdateInstructionsTool())
