# Import all v2 tools to trigger self-registration with the canonical registry.
# Add each new tool module here as it is implemented.
from . import normalize_voice_intent      # noqa: F401
from . import get_order                   # noqa: F401
from . import search_catalog              # noqa: F401
from . import calculate_pricing           # noqa: F401
from . import send_payment_link           # noqa: F401
from . import get_caller_info             # noqa: F401
from . import check_facility_approval     # noqa: F401

from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

__all__ = ["registry", "BaseTool", "ToolContext", "ToolResult"]
