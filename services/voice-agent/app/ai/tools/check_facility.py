from typing import Any

from .base import BaseTool, ToolContext, ToolResult
from .registry import registry


class CheckFacilityTool(BaseTool):
    name = "check_facility"
    description = (
        "Check whether a correctional facility is approved to receive shipments "
        "and what restrictions apply. Call this when the caller mentions a prison, "
        "jail, or correctional facility."
    )
    parameters = {
        "type": "object",
        "properties": {
            "facility_name": {
                "type": "string",
                "description": "Name of the correctional facility",
            },
            "state": {
                "type": "string",
                "description": "US state (abbreviation or full name)",
            },
            "order_number": {
                "type": "string",
                "description": "Order number to check items against facility restrictions",
            },
        },
        "required": ["facility_name"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        facility_name = args.get("facility_name", "").strip()
        state = args.get("state", "")

        if not facility_name:
            return ToolResult(
                success=False,
                data={},
                voice_summary="Which facility are you shipping to?",
                error="No facility name provided",
            )

        # Phase 1: mock — Phase 2 queries facilities table
        return ToolResult(
            success=True,
            data={
                "facility_found": True,
                "facility_name": facility_name,
                "state": state,
                "approved": True,
                "restrictions": [
                    "Paperback books only",
                    "Publisher must be on approved list",
                ],
                "blocked_items": [],
            },
            voice_summary=(
                f"{facility_name} is on our approved facility list. "
                "They accept paperback books from approved publishers. "
                "Would you like to go ahead and place your order?"
            ),
        )


registry.register(CheckFacilityTool())
