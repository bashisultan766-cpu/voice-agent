"""
OpenAI-compatible tool schema adapter for Main Commerce Brain.

Exposes a curated, safety-reviewed subset of commerce tools with validated
JSON schemas — no Pydantic objects, no duplicate names, no internal-only tools.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from ..agent_runtime import llm_tools

logger = logging.getLogger(__name__)

# Safe commerce tools exposed to the Main LLM Brain.
# create_checkout and other internal-only tools are intentionally excluded.
MAIN_BRAIN_TOOL_NAMES: tuple[str, ...] = (
    "search_products",
    "search_product_by_isbn",
    "catalog_search",
    "get_product_details",
    "add_to_cart",
    "update_cart",
    "remove_from_cart",
    "get_cart",
    "send_payment_link",
    "lookup_order_status",
    "lookup_shopify_order_details",
    "get_order_details",
    "get_customer_order_history",
    "lookup_refund_status",
    "facility_policy_lookup",
    "search_facility_policy",
    "check_facility_content_allowed",
    "explain_facility_restriction",
    "escalate_to_customer_service",
    "create_product_not_found_escalation",
    "create_customer_query_escalation",
)

_S = {"type": "string"}
_I = {"type": "integer"}
_A = {"type": "array", "items": _S}

# Schema overrides for known-bad registrations in llm_tools.
_SCHEMA_OVERRIDES: dict[str, dict] = {
    "classify_product_content_for_facility": {
        "type": "object",
        "properties": {
            "product_title": _S,
            "product_description": _S,
            "product_type": _S,
            "product_tags": _A,
        },
        "required": [],
    },
}


def _obj(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required}


def _sanitize_parameters(params: dict, tool_name: str) -> dict:
    """Ensure parameters conform to OpenAI function-calling JSON schema rules."""
    if tool_name in _SCHEMA_OVERRIDES:
        return dict(_SCHEMA_OVERRIDES[tool_name])

    if not isinstance(params, dict):
        return _obj({}, [])

    props = params.get("properties") or {}
    clean_props: dict[str, Any] = {}
    for key, val in props.items():
        if isinstance(val, dict) and ("type" in val or "anyOf" in val or "oneOf" in val):
            clean_props[key] = val
        elif isinstance(val, list):
            # e.g. product_tags: [] — invalid; coerce to string array.
            clean_props[key] = _A
        else:
            clean_props[key] = _S

    required = params.get("required") or []
    if not isinstance(required, list):
        required = []
    required = [r for r in required if r in clean_props]

    return _obj(clean_props, required)


def _build_spec(name: str, description: str, parameters: dict) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": _sanitize_parameters(parameters, name),
        },
    }


def get_main_brain_tool_specs() -> list[dict]:
    """
    Return OpenAI-compatible tool schemas for Main Commerce Brain.

    Only exposes MAIN_BRAIN_TOOL_NAMES. Schemas are JSON-serializable and
    validated before return.
    """
    specs: list[dict] = []
    seen: set[str] = set()

    for name in MAIN_BRAIN_TOOL_NAMES:
        if name in seen:
            logger.warning("main_brain_tool_duplicate name=%s", name)
            continue
        # Pull schema from canonical registry via tool_specs (customer-facing).
        match = next(
            (s for s in llm_tools.tool_specs() if s["function"]["name"] == name),
            None,
        )
        if match is None:
            logger.warning("main_brain_tool_missing name=%s", name)
            continue
        seen.add(name)
        fn = match["function"]
        specs.append(_build_spec(name, fn["description"], fn["parameters"]))

    # Final validation — must be JSON-serializable.
    try:
        json.dumps(specs)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"Main brain tool specs not JSON-serializable: {exc}") from exc

    names = [s["function"]["name"] for s in specs]
    if len(names) != len(set(names)):
        raise RuntimeError("Duplicate tool names in main brain specs")

    return specs


def validate_main_brain_tool_specs() -> list[str]:
    """Return a list of validation issues (empty = valid)."""
    from .openai_request_utils import _find_invalid_schema_properties

    issues: list[str] = []
    try:
        specs = get_main_brain_tool_specs()
    except RuntimeError as exc:
        return [str(exc)]

    for spec in specs:
        fn = spec["function"]["name"]
        issues.extend(_find_invalid_schema_properties(spec["function"]["parameters"], fn))

    try:
        json.dumps(specs)
    except (TypeError, ValueError) as exc:
        issues.append(f"not serializable: {exc}")

    return issues
