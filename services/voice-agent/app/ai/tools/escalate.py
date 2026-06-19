import logging
from typing import Any

from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

logger = logging.getLogger(__name__)


class EscalateTool(BaseTool):
    name = "escalate"
    description = (
        "Escalate the call to a human team member. Use when: "
        "the caller explicitly asks for a human, "
        "a product cannot be found after searching, "
        "the question is too complex to answer, "
        "or the caller is frustrated."
    )
    parameters = {
        "type": "object",
        "properties": {
            "reason": {
                "type": "string",
                "enum": [
                    "customer_request",
                    "product_not_found",
                    "complex_question",
                    "frustrated_caller",
                    "other",
                ],
            },
            "summary": {
                "type": "string",
                "description": "Brief summary of what was discussed",
            },
            "order_number": {
                "type": "string",
                "description": "Order number if relevant",
            },
        },
        "required": ["reason", "summary"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        reason = args.get("reason", "other")
        summary = args.get("summary", "")
        order_number = args.get("order_number")

        logger.info(
            "Escalation: call_sid=%s from=%s reason=%s order=%s summary=%r",
            context.call_sid,
            context.from_number,
            reason,
            order_number,
            summary[:100],
        )

        # Phase 2: INSERT callback_requests + optional SMS alert
        return ToolResult(
            success=True,
            data={"queued": True, "reason": reason},
            voice_summary=context.agent_config.escalation_message,
            state_update={"conversation_state": "ESCALATED"},
        )


registry.register(EscalateTool())
