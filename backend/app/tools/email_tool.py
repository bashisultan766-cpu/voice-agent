from __future__ import annotations
from typing import Any, Dict
from app.tools.base import BaseTool, ToolContext
from app.integrations.resend_client import send_email, payment_link_html


class EmailTool(BaseTool):
    name = "email"
    description = (
        "Send an email to the customer. Primarily used to deliver a payment/checkout link. "
        "Requires a verified customer email and a checkout URL."
    )
    parameters = {
        "type": "object",
        "properties": {
            "to": {
                "type": "string",
                "description": "Customer email address to send to",
            },
            "checkout_url": {
                "type": "string",
                "description": "The checkout or payment URL to include in the email",
            },
            "product_name": {
                "type": "string",
                "description": "Product name for display in the email",
            },
            "amount": {
                "type": "string",
                "description": "Total order amount (e.g. '$29.99')",
            },
            "subject": {
                "type": "string",
                "description": "Email subject line",
            },
        },
        "required": ["to", "checkout_url"],
    }

    async def execute(self, ctx: ToolContext, **kwargs: Any) -> Dict[str, Any]:
        to: str = kwargs.get("to", "")
        checkout_url: str = kwargs.get("checkout_url", "")
        product_name: str = kwargs.get("product_name", "")
        amount: str = kwargs.get("amount", "")
        subject: str = kwargs.get("subject", "Your Payment Link")

        if not to:
            return {"error": "Recipient email is required."}
        if not checkout_url:
            return {"error": "Checkout URL is required."}

        html = payment_link_html(checkout_url, product_name, amount)
        success = await send_email(
            to=to,
            subject=subject,
            html=html,
            from_email=ctx.from_email or None,
            api_key=ctx.resend_api_key or None,
        )

        if success:
            return {
                "success": True,
                "message": f"Payment link sent to {to}. Please check your email.",
            }
        return {
            "success": False,
            "message": "Failed to send email. Please try again later.",
        }
