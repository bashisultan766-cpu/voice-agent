# Import all v2 tools to trigger self-registration with the canonical registry.
# Add each new tool module here as it is implemented.
from . import normalize_voice_intent              # noqa: F401
from . import get_order                           # noqa: F401
from . import search_catalog                      # noqa: F401
from . import calculate_pricing                   # noqa: F401
from . import send_payment_link                   # noqa: F401
from . import get_caller_info                     # noqa: F401
from . import check_facility_approval             # noqa: F401
from . import check_order_facility_restrictions   # noqa: F401
from . import address_update_instructions         # noqa: F401
from . import cancel_order_request                # noqa: F401
from . import escalate_to_customer_service        # noqa: F401
from . import send_facility_payment_link          # noqa: F401
from . import save_caller_name                    # noqa: F401

from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

__all__ = ["registry", "BaseTool", "ToolContext", "ToolResult"]
