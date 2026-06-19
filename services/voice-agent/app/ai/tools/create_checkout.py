from typing import Any

from .base import BaseTool, ToolContext, ToolResult
from .registry import registry


class CreateCheckoutTool(BaseTool):
    name = "create_checkout"
    description = (
        "Create a Shopify draft order and email the customer a payment link. "
        "ONLY call this after the customer's email has been confirmed. "
        "email_confirmed MUST be true — never call with false."
    )
    parameters = {
        "type": "object",
        "properties": {
            "email": {
                "type": "string",
                "description": "Customer email address (must be the confirmed email)",
            },
            "email_confirmed": {
                "type": "boolean",
                "description": "Must be true. Only proceed when customer confirmed their email.",
            },
            "items": {
                "type": "array",
                "description": "Items to order",
                "items": {
                    "type": "object",
                    "properties": {
                        "variant_id": {"type": "string"},
                        "quantity": {"type": "integer", "minimum": 1},
                        "title": {"type": "string"},
                    },
                    "required": ["variant_id", "quantity"],
                },
            },
        },
        "required": ["email", "email_confirmed", "items"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        email_confirmed = args.get("email_confirmed", False)
        email = args.get("email", "").strip()
        items = args.get("items", [])

        if not email_confirmed:
            return ToolResult(
                success=False,
                data={},
                voice_summary="I need to confirm your email address first. What is your email?",
                error="Email not confirmed",
                state_update={"email_fsm_state": "COLLECTING"},
            )

        if not email:
            return ToolResult(
                success=False,
                data={},
                voice_summary="I need your email address to send the payment link.",
                error="No email provided",
                state_update={"email_fsm_state": "COLLECTING"},
            )

        if not items:
            return ToolResult(
                success=False,
                data={},
                voice_summary="What would you like to order?",
                error="No items",
            )

        from ...shopify import get_shopify_client
        client = get_shopify_client(
            domain=context.agent_config.shopify_domain,
            access_token=context.agent_config.shopify_access_token,
        )

        result = await client.create_draft_order(
            email=email,
            items=items,
            customer_phone=context.from_number,
            note=f"Voice order — {context.call_sid}",
        )

        if not result.success:
            return ToolResult(
                success=False,
                data={},
                voice_summary="I had trouble creating your order. Let me connect you with our team.",
                error=result.error,
            )

        return ToolResult(
            success=True,
            data=result.model_dump(),
            voice_summary=result.voice_summary,
            state_update={
                "conversation_state": "CHECKOUT_SENT",
                "customer_email": email,
            },
        )


registry.register(CreateCheckoutTool())
