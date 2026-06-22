"""
Tool dispatcher: routes OpenAI function-call names to implementations.
"""
from __future__ import annotations

import hashlib
import json
import logging

from ..state.models import SessionState
from . import shopify_tools as _st

logger = logging.getLogger(__name__)

_TOOL_MAP = {
    "search_products": _st.search_products,
    "get_product_details": _st.get_product_details,
    "lookup_order": _st.lookup_order,
    "get_refund_status": _st.get_refund_status,
    "create_checkout_link": _st.create_checkout_link,
    "send_payment_link_email": _st.send_payment_link_email_tool,
    "escalate_to_human": _st.escalate_to_human,
}

# Tools that receive the live session for context injection and state mutation.
_SESSION_AWARE = frozenset({
    "lookup_order",
    "get_refund_status",
    "create_checkout_link",
    "send_payment_link_email",
    "escalate_to_human",
})


def _prefetch_key(name: str, args: dict) -> str:
    """Match the key computed by pipeline.tool_executor.prefetch_key."""
    clean = {k: v for k, v in args.items() if k != "session"}
    payload = json.dumps(clean, sort_keys=True)
    digest = hashlib.sha256(payload.encode()).hexdigest()[:12]
    return f"{name}:{digest}"


async def dispatch(name: str, args: dict, session: SessionState) -> str:
    """
    Execute the named tool with the given args.

    - Checks session.prefetch_cache first (set by RealtimePipelineEngine).
    - Injects caller_phone into escalate_to_human automatically.
    - Injects session into session-aware tools.
    - Catches all exceptions and returns a safe error JSON string.
    - Never raises.
    """
    fn = _TOOL_MAP.get(name)
    if fn is None:
        logger.warning("Unknown tool requested: %s", name)
        return json.dumps({"error": f"Tool '{name}' not available."})

    # Serve from prefetch cache when available — avoids duplicate Shopify calls.
    cache_key = _prefetch_key(name, args)
    if session.prefetch_cache.get(cache_key):
        logger.debug("Prefetch cache hit tool=%s", name)
        return session.prefetch_cache[cache_key]

    if name == "escalate_to_human":
        args.setdefault("caller_phone", session.from_number)

    if name in _SESSION_AWARE:
        args = {**args, "session": session}

    logger.info("Dispatching tool=%s args_keys=%s", name, [k for k in args if k != "session"])
    try:
        return await fn(**args)
    except TypeError as exc:
        logger.warning("Tool %s bad args %s: %s", name, args, exc)
        return json.dumps({"error": "Invalid tool arguments. Please try again."})
    except Exception:
        logger.exception("Tool %s raised unexpectedly", name)
        return json.dumps({"error": "Tool temporarily unavailable."})
