from typing import Any

from .base import BaseTool, ToolContext, ToolResult
from .registry import registry


class GetCallerProfileTool(BaseTool):
    name = "get_caller_profile"
    description = (
        "Look up a caller profile by phone number to check if they are a returning customer "
        "and retrieve their name and purchase history. "
        "Optionally save their name if they just introduced themselves."
    )
    parameters = {
        "type": "object",
        "properties": {
            "phone_number": {
                "type": "string",
                "description": "Caller phone number in E.164 format",
            },
            "save_name": {
                "type": "string",
                "description": "Full name to save for this caller (if they introduced themselves)",
            },
        },
        "required": ["phone_number"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        save_name: str | None = args.get("save_name")

        state_update: dict[str, Any] = {}
        if save_name:
            first_name = save_name.strip().split()[0]
            state_update["caller_name"] = first_name

        # Phase 1: mock — Phase 2 queries caller_profiles table
        return ToolResult(
            success=True,
            data={
                "is_new_caller": True,
                "name": save_name,
                "first_name": save_name.split()[0] if save_name else None,
                "call_count": 0,
                "past_purchases": [],
            },
            voice_summary=(
                f"Nice to meet you{', ' + save_name.split()[0] if save_name else ''}! "
                "How can I help you today?"
            ),
            state_update=state_update or None,
        )


registry.register(GetCallerProfileTool())
