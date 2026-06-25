"""
Tool dispatcher: routes OpenAI function-call names to implementations.

v4.2: ElevenLabs-aligned tool names added alongside legacy names.
All tool_schemas.py names are registered here.
"""
from __future__ import annotations

import hashlib
import json
import logging

from ..state.models import SessionState
from . import shopify_tools as _st

logger = logging.getLogger(__name__)

# ── ElevenLabs-aligned names (match tool_schemas.py) ─────────────────────────
_TOOL_MAP = {
    # Primary ElevenLabs names
    "NormalizeVoiceIntent":          _st.NormalizeVoiceIntent,
    "GetOrder":                      _st.GetOrder,
    "SureShotCatalogSearch":         _st.SureShotCatalogSearch,
    "CalculatePricing":              _st.CalculatePricing,
    "CheckFacilityApproval":         _st.CheckFacilityApproval,
    "CheckOrderFacilityRestrictions": _st.CheckOrderFacilityRestrictions,
    "AddressUpdateInstructions":     _st.AddressUpdateInstructions,
    "CancelOrderRequest":            _st.CancelOrderRequest,
    "EscalateToCustomerService":     _st.EscalateToCustomerService,
    "SendFacilityPaymentLink":       _st.SendFacilityPaymentLink,
    "SendPaymentLink":               _st.SendPaymentLink,
    "GetCallerInfo":                 _st.GetCallerInfo,
    "SaveCallerName":                _st.SaveCallerName,
    "SearchBookByISBN":              _st.SearchBookByISBN,
    "SearchBookByTitle":             _st.SearchBookByTitle,
    "SearchCustomerByPhone":         _st.SearchCustomerByPhone,
    "SearchOrdersByPhone":           _st.SearchOrdersByPhone,
    # Legacy aliases (ElevenLabs prompt mentions these)
    "SureShotBooksSku":              _st.SureShotBooksSku,
    "SureShotBooksProductFetcher":   _st.SureShotBooksProductFetcher,
    "SureShotBooksProduct":          _st.SureShotBooksProduct,
    # Backward-compat names (used by existing tests and internal callers)
    "search_products":               _st.search_products,
    "get_product_details":           _st.get_product_details,
    "lookup_order":                  _st.lookup_order,
    "get_refund_status":             _st.get_refund_status,
    "create_checkout_link":          _st.create_checkout_link,
    "send_payment_link_email":       _st.send_payment_link_email_tool,
    "escalate_to_human":             _st.escalate_to_human,
}

# Tools that receive the live session for context injection and state mutation.
_SESSION_AWARE = frozenset({
    # ElevenLabs names
    "NormalizeVoiceIntent",
    "GetOrder",
    "CalculatePricing",
    "CheckFacilityApproval",
    "CheckOrderFacilityRestrictions",
    "AddressUpdateInstructions",
    "CancelOrderRequest",
    "EscalateToCustomerService",
    "SendFacilityPaymentLink",
    "SendPaymentLink",
    "GetCallerInfo",
    "SaveCallerName",
    "SearchBookByISBN",
    "SearchCustomerByPhone",
    "SearchOrdersByPhone",
    # Backward-compat names
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
    - Injects caller_phone into escalation tools automatically.
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

    # Auto-inject caller_phone for escalation tools
    if name in ("escalate_to_human", "EscalateToCustomerService"):
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
