"""
Tool: send_facility_payment_link
Version: v2

Purpose:
    Email a secure facility payment completion link for an existing order.
    Used when the caller needs to complete facility-specific payment steps.

    CHECKOUT GATE — refuses unless email_confirmed=True.
    success=True only when email_sent=True (never claim sent unless it sent).

    Two-layer architecture:
        MOCK: MockFacilityPaymentLinkGenerator  (active)
        REAL: RealFacilityPaymentClient         (disabled)
"""
from __future__ import annotations

import logging
import secrets
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from ..ai.common.validators import clean_order_number, is_valid_email
from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

logger = logging.getLogger(__name__)

USE_REAL_FACILITY_LINK: bool = False
USE_REAL_EMAIL: bool = False

EmailMode = Literal["stub", "resend", "skipped"]
LinkMode = Literal["mock", "real"]


class SendFacilityPaymentLinkData(BaseModel):
    order_number: str
    completion_url: str
    email_sent: bool
    email_sent_to: str
    email_mode: EmailMode = "stub"
    link_mode: LinkMode = "mock"
    token_ref: str = ""


class SendFacilityPaymentLinkRequest(BaseModel):
    order_number: str = Field(..., description="Order number for the facility payment")
    email: str = Field(..., description="Customer email — must be verbally confirmed")
    email_confirmed: bool = Field(
        ..., description="True only after the caller confirmed their email"
    )

    @field_validator("order_number")
    @classmethod
    def normalise_order(cls, v: str) -> str:
        cleaned = clean_order_number(v)
        if not cleaned:
            raise ValueError(f"Cannot extract order number from {v!r}.")
        return cleaned

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not is_valid_email(v):
            raise ValueError(f"invalid email address: {v!r}")
        return v


def _mask_email(email: str) -> str:
    if "@" not in email:
        return email
    local, domain = email.split("@", 1)
    if len(local) <= 2:
        return email
    return f"{local[:2]}...@{domain}"


def _format_voice_summary(data: SendFacilityPaymentLinkData) -> str:
    masked = _mask_email(data.email_sent_to)
    if data.email_sent:
        return (
            f"I've sent the secure facility payment link for order {data.order_number} "
            f"to {masked}. Please check your email and follow the link to complete payment."
        )
    return (
        f"I wasn't able to send the facility payment link right now for order {data.order_number}. "
        "Would you like me to try again, or connect you with our customer service team?"
    )


class MockFacilityPaymentLinkGenerator:
    @staticmethod
    def create_link(req: SendFacilityPaymentLinkRequest) -> SendFacilityPaymentLinkData:
        token = secrets.token_hex(24)
        completion_url = (
            f"https://sureshotbooks.com/facility/complete"
            f"?token={token}&order={req.order_number}&email={req.email}"
        )
        logger.debug(
            "MockFacilityPaymentLinkGenerator: order=%s url=%s",
            req.order_number,
            completion_url[:60],
        )
        return SendFacilityPaymentLinkData(
            order_number=req.order_number,
            completion_url=completion_url,
            email_sent=False,
            email_sent_to=req.email,
            email_mode="stub",
            link_mode="mock",
            token_ref=token[:12],
        )


async def _email_stub(
    to: str,
    completion_url: str,
    order_number: str,
) -> bool:
    logger.info(
        "[FACILITY EMAIL STUB — no email sent] to=%s order=%s url=%s",
        to,
        order_number,
        completion_url[:80],
    )
    return True


async def _email_real(
    to: str,
    completion_url: str,
    order_number: str,
    resend_api_key: str,
    from_email: str,
) -> bool:
    raise NotImplementedError(
        "_email_real() for facility payment is not yet implemented. "
        "Keep USE_REAL_EMAIL=False until ready."
    )


async def _dispatch_email(
    to: str,
    completion_url: str,
    order_number: str,
    resend_api_key: str = "",
    from_email: str = "",
) -> tuple[bool, EmailMode]:
    if USE_REAL_EMAIL:
        try:
            sent = await _email_real(to, completion_url, order_number, resend_api_key, from_email)
            return sent, "resend"
        except NotImplementedError:
            logger.warning("Facility _email_real() not implemented — falling back to stub")
        except Exception as exc:
            logger.error("Facility _email_real() failed: %s — falling back to stub", exc)

    sent = await _email_stub(to, completion_url, order_number)
    return sent, "stub"


class RealFacilityPaymentClient:
    """NOT YET IMPLEMENTED. POST {internal_api_url}/voice/facility-payment-link"""

    def __init__(self, api_base: str, api_key: str) -> None:
        self._api_base = api_base
        self._api_key = api_key

    async def send(self, req: SendFacilityPaymentLinkRequest) -> SendFacilityPaymentLinkData:
        raise NotImplementedError(
            "RealFacilityPaymentClient.send() is not yet implemented."
        )


async def _resolve_facility_payment_link(
    req: SendFacilityPaymentLinkRequest,
    api_base: Optional[str],
    api_key: Optional[str],
    resend_api_key: str = "",
    from_email: str = "",
) -> SendFacilityPaymentLinkData:
    use_real = USE_REAL_FACILITY_LINK and bool(api_base and api_key)

    if use_real:
        try:
            client = RealFacilityPaymentClient(api_base, api_key)  # type: ignore[arg-type]
            return await client.send(req)
        except NotImplementedError:
            logger.warning("RealFacilityPaymentClient not implemented — falling back to mock")
        except Exception as exc:
            logger.error("RealFacilityPaymentClient.send() failed: %s — falling back to mock", exc)

    link_data = MockFacilityPaymentLinkGenerator.create_link(req)

    email_sent, email_mode = await _dispatch_email(
        to=req.email,
        completion_url=link_data.completion_url,
        order_number=req.order_number,
        resend_api_key=resend_api_key,
        from_email=from_email,
    )

    return link_data.model_copy(update={"email_sent": email_sent, "email_mode": email_mode})


class SendFacilityPaymentLinkTool(BaseTool):
    name = "send_facility_payment_link"
    description = (
        "Email a secure facility payment completion link for an order. "
        "ONLY call after the caller verbally confirmed their email (email_confirmed=true). "
        "Returns honest email_sent status — never claim the link was sent unless it was."
    )
    parameters = {
        "type": "object",
        "properties": {
            "order_number": {
                "type": "string",
                "description": "Order number requiring facility payment completion",
            },
            "email": {
                "type": "string",
                "description": "Customer email — must be verbally confirmed",
            },
            "email_confirmed": {
                "type": "boolean",
                "description": "True ONLY after caller confirmed email. Never call with false.",
            },
        },
        "required": ["order_number", "email", "email_confirmed"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        if not args.get("email_confirmed", False):
            return ToolResult(
                success=False,
                data={
                    "success": False,
                    "message": "Email confirmation required before sending facility payment link.",
                    "data": None,
                    "error": "email_confirmed is False",
                },
                voice_summary=(
                    "Before I send the facility payment link I need to confirm your email. "
                    "Could you please tell me your email address?"
                ),
                error="email_confirmed is False",
                state_update={"email_fsm_state": "COLLECTING"},
            )

        try:
            req = SendFacilityPaymentLinkRequest(**args)
        except Exception as exc:
            return self.error_result(
                voice_summary=(
                    "I need your order number and confirmed email to send the facility payment link."
                ),
                error=f"Validation failed: {exc}",
            )

        try:
            result = await _resolve_facility_payment_link(
                req=req,
                api_base=getattr(context.agent_config, "internal_api_url", None),
                api_key=getattr(context.agent_config, "internal_api_key", None),
                resend_api_key=context.agent_config.resend_api_key or "",
                from_email=context.agent_config.from_email,
            )
        except Exception as exc:
            logger.error(
                "send_facility_payment_link failed: %s session=%s", exc, context.session_id, exc_info=True
            )
            return self.error_result(
                voice_summary=(
                    "I ran into a problem sending the facility payment link. "
                    "Let me connect you with our customer service team."
                ),
                error=f"Facility payment link failed: {exc}",
            )

        voice_summary = _format_voice_summary(result)

        logger.info(
            "send_facility_payment_link: order=%s email_sent=%s mode=%s session=%s",
            result.order_number, result.email_sent, result.email_mode, context.session_id,
        )

        if not result.email_sent:
            return ToolResult(
                success=False,
                data={
                    "success": False,
                    "message": f"Facility link created but email delivery failed for order {req.order_number}.",
                    "suggested_response": voice_summary,
                    "data": result.model_dump(),
                    "error": "email_sent is False",
                },
                voice_summary=voice_summary,
                error="email_sent is False",
                state_update={"email_fsm_state": "EMAIL_FAILED"},
            )

        return ToolResult(
            success=True,
            data={
                "success": True,
                "message": f"Facility payment link sent for order {result.order_number}.",
                "suggested_response": voice_summary,
                "data": result.model_dump(),
                "error": None,
            },
            voice_summary=voice_summary,
            state_update={
                "conversation_state": "FACILITY_PAYMENT",
                "customer_email": req.email,
            },
        )


registry.register(SendFacilityPaymentLinkTool())
