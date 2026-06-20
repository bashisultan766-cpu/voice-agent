"""
Tool: cancel_order_request
Version: v2

Purpose:
    Attempt to cancel an order that has not yet shipped.

    Three distinct outcomes — success=True for all (the check ran correctly):
        request_submitted  → order not yet shipped; cancellation request logged
        not_eligible       → order shipped, voided, or already refunded
        requires_cs        → partial fulfilment or unclear state; human must handle

    CRITICAL:
        Never says "order cancelled". The mock only SUBMITS a REQUEST.
        Voice must say "cancellation request submitted", never "order is cancelled".

    Two-layer architecture:
        MOCK: MockCancelService  (active — logs request, returns confirmation ID)
        REAL: RealCancelClient   (disabled — calls Shopify cancel order endpoint)
"""
from __future__ import annotations

import logging
import secrets
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from ..ai.common.validators import clean_order_number
from .base import BaseTool, ToolContext, ToolResult
from .get_order import MockOrderRepository, _check_cancel_eligibility
from .registry import registry

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1 — Domain models
# ─────────────────────────────────────────────────────────────────────────────

CancelOutcome = Literal["request_submitted", "not_eligible", "requires_cs"]


class CancelRequestData(BaseModel):
    outcome: CancelOutcome
    order_number: str
    confirmation_id: Optional[str] = None   # set only when request_submitted
    eligibility_reason: str
    source: Literal["mock", "real"] = "mock"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 2 — Request model
# ─────────────────────────────────────────────────────────────────────────────


class CancelOrderRequest(BaseModel):
    order_number: str = Field(..., description="Order number to cancel")

    @field_validator("order_number")
    @classmethod
    def normalise(cls, v: str) -> str:
        cleaned = clean_order_number(v)
        if not cleaned:
            raise ValueError(f"Cannot extract a valid order number from {v!r}.")
        return cleaned


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 3 — Voice summary formatter (pure, zero I/O)
# ─────────────────────────────────────────────────────────────────────────────


def _format_voice_summary(data: CancelRequestData) -> str:
    if data.outcome == "request_submitted":
        return (
            f"Your cancellation request for order {data.order_number} has been submitted. "
            f"Your confirmation reference is {data.confirmation_id}. "
            "Our team will process it shortly and you'll receive an email confirmation."
        )
    if data.outcome == "not_eligible":
        return (
            f"I'm sorry, order {data.order_number} cannot be cancelled. "
            f"{data.eligibility_reason}"
        )
    # requires_cs
    return (
        f"Order {data.order_number} requires our customer service team to handle the cancellation. "
        f"{data.eligibility_reason} Would you like me to connect you with the team?"
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4 — MOCK LAYER
# ─────────────────────────────────────────────────────────────────────────────


class MockCancelService:
    @staticmethod
    def cancel(order_number: str) -> CancelRequestData:
        order = MockOrderRepository.get(order_number)

        if not order.found:
            return CancelRequestData(
                outcome="not_eligible",
                order_number=order_number,
                eligibility_reason="Order not found.",
                source="mock",
            )

        eligibility = _check_cancel_eligibility(
            financial_status=order.financial_status,
            fulfillment_status=order.fulfillment_status,
        )

        if not eligibility.can_cancel:
            return CancelRequestData(
                outcome="not_eligible",
                order_number=order_number,
                eligibility_reason=eligibility.reason,
                source="mock",
            )

        if eligibility.requires_human:
            return CancelRequestData(
                outcome="requires_cs",
                order_number=order_number,
                eligibility_reason=eligibility.reason,
                source="mock",
            )

        # Eligible — submit mock request
        confirmation_id = f"CXL-{secrets.token_hex(3).upper()}"
        logger.info(
            "[CANCEL STUB] order=%s confirmation=%s", order_number, confirmation_id
        )
        return CancelRequestData(
            outcome="request_submitted",
            order_number=order_number,
            confirmation_id=confirmation_id,
            eligibility_reason=eligibility.reason,
            source="mock",
        )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 5 — REAL PATH PLACEHOLDER
# ─────────────────────────────────────────────────────────────────────────────


class RealCancelClient:
    """NOT YET IMPLEMENTED. POST {shopify_domain}/admin/api/orders/{id}/cancel.json"""

    def __init__(self, domain: str, access_token: str) -> None:
        self._domain = domain
        self._access_token = access_token

    async def cancel(self, order_number: str) -> CancelRequestData:
        raise NotImplementedError(
            "RealCancelClient.cancel() is not yet implemented. "
            "Keep USE_REAL_SHOPIFY=False until this is ready."
        )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 6 — Resolver
# ─────────────────────────────────────────────────────────────────────────────


async def _resolve_cancel(
    order_number: str,
    shopify_domain: Optional[str],
    shopify_access_token: Optional[str],
) -> CancelRequestData:
    use_real = bool(shopify_domain and shopify_access_token)
    if use_real:
        try:
            client = RealCancelClient(shopify_domain, shopify_access_token)  # type: ignore[arg-type]
            return await client.cancel(order_number)
        except NotImplementedError:
            logger.warning("RealCancelClient not implemented — falling back to mock")
        except Exception as exc:
            logger.error("RealCancelClient.cancel() failed: %s — falling back to mock", exc)

    return MockCancelService.cancel(order_number)


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 7 — Tool class
# ─────────────────────────────────────────────────────────────────────────────


class CancelOrderRequestTool(BaseTool):
    name = "cancel_order_request"
    description = (
        "Request cancellation of an order that has not yet shipped. "
        "Returns request_submitted (not shipped — request logged), "
        "not_eligible (shipped or already cancelled), "
        "or requires_cs (partial shipment — human must handle). "
        "NEVER claims the order is cancelled — only that the request was submitted."
    )
    parameters = {
        "type": "object",
        "properties": {
            "order_number": {
                "type": "string",
                "description": "Order number to cancel",
            },
        },
        "required": ["order_number"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        try:
            req = CancelOrderRequest(**args)
        except Exception as exc:
            return self.error_result(
                voice_summary="I didn't catch the order number. Could you repeat it?",
                error=f"Invalid input: {exc}",
            )

        try:
            result = await _resolve_cancel(
                order_number=req.order_number,
                shopify_domain=context.agent_config.shopify_domain,
                shopify_access_token=context.agent_config.shopify_access_token,
            )
        except Exception as exc:
            logger.error(
                "cancel_order_request(%s) failed: %s", req.order_number, exc, exc_info=True
            )
            return self.error_result(
                voice_summary=(
                    "I ran into a problem processing that cancellation request. "
                    "Let me connect you with our customer service team."
                ),
                error=f"Cancel request failed: {exc}",
            )

        voice_summary = _format_voice_summary(result)

        logger.info(
            "cancel_order_request: order=%s outcome=%s confirmation=%s source=%s session=%s",
            result.order_number, result.outcome, result.confirmation_id,
            result.source, context.session_id,
        )

        state_update: dict[str, Any] = {}
        if result.outcome == "request_submitted":
            state_update["conversation_state"] = "CANCEL_REQUESTED"
        elif result.outcome == "requires_cs":
            state_update["conversation_state"] = "ESCALATED"

        return ToolResult(
            success=True,
            data={
                "success": True,
                "message": f"Cancel request for order {result.order_number}: {result.outcome}.",
                "suggested_response": voice_summary,
                "data": result.model_dump(),
                "error": None,
            },
            voice_summary=voice_summary,
            state_update=state_update or None,
        )


# ── Self-register ─────────────────────────────────────────────────────────────

registry.register(CancelOrderRequestTool())
