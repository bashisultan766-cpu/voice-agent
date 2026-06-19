"""
Shared response schema used by every v2 tool.

Every tool's ToolResult.data must conform to ToolResponse so the
OpenAI tool-call message is predictable and parseable.
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel


class ToolResponse(BaseModel):
    """
    Canonical envelope returned inside ToolResult.data for every v2 tool.

    Example (success):
        {
            "success": true,
            "message": "Order #1234 found.",
            "data": { ... },
            "error": null
        }

    Example (failure):
        {
            "success": false,
            "message": "Order not found.",
            "data": null,
            "error": "Shopify returned 404 for order #9999"
        }
    """

    success: bool
    message: str
    data: Optional[dict[str, Any]] = None
    error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump()
