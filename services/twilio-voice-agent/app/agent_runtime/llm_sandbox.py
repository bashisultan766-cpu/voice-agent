"""
LLM input sandbox — strip internal workflow state before model calls.

The LLM may only receive:
- static system instructions
- cleaned user/assistant dialogue
- non-structured conversation summary prose

It must never observe workflow routing, tool selection hints, or raw resolution payloads.
"""
from __future__ import annotations

import json
import re
from typing import Any

LLM_SANDBOX_VERSION = "v1.0"

_VALID_ROLES = frozenset({"system", "user", "assistant", "tool"})

# Workflow / routing identifiers
_WORKFLOW_PATTERN = re.compile(
    r"\b(?:product_search_workflow|support_handoff_workflow|order_workflow|"
    r"workflow_[a-z_]+|WORKFLOW_[A-Z_]+)\b",
    re.I,
)

# Structured commerce / resolution payloads
_STRUCTURED_JSON_PATTERN = re.compile(
    r"\{[^{}]*(?:\"(?:variant_id|product_id|tool_results|match_score|"
    r"gid://shopify|workflow|escalation_eligible)\"[^{}]*)+\}",
    re.I,
)
_SHOPIFY_GID_PATTERN = re.compile(r"gid://shopify/\S+", re.I)
_VARIANT_ID_PATTERN = re.compile(r"\bvariant_id\b", re.I)

# Tool-routing instructions injected into context (not static system prompt file)
_TOOL_ROUTING_LINE = re.compile(
    r"^\s*-\s*(?:Resolved ISBN|ISBN digit buffer|Caller is reading an ISBN|"
    r"Caller intent hint|Tone hint|send_payment_link is allowed|"
    r"Awaiting cart confirmation|Call search_product|catalog_search|"
    r"search_products|tool_choice|available tools).*$",
    re.I | re.M,
)
_LIVE_STATE_HEADER = re.compile(r"^\s*LIVE CALL STATE\b", re.I | re.M)
_INTERNAL_STATE_LINE = re.compile(
    r"^\s*-\s*(?:Payment flow|Commerce flow|Pending email|Awaiting email|"
    r"Identity verified|Last order|Email confirmed|Cart:).*$",
    re.I | re.M,
)

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

# Tool names whose raw JSON must never reach the model
_STRUCTURED_TOOL_NAMES = frozenset({
    "catalog_search",
    "search_products",
    "search_product_by_isbn",
    "lookup_shopify_order_details",
    "get_order_details",
    "get_customer_order_history",
    "create_product_not_found_escalation",
    "escalate_to_customer_service",
})


def sanitize_user_text(text: str) -> str:
    """Clean caller text for LLM user role."""
    cleaned = (text or "").strip()
    cleaned = _CONTROL_CHARS.sub("", cleaned)
    cleaned = _SHOPIFY_GID_PATTERN.sub("", cleaned)
    cleaned = _WORKFLOW_PATTERN.sub("", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def _strip_live_call_state_block(text: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    skipping = False
    for line in lines:
        if _LIVE_STATE_HEADER.match(line):
            skipping = True
            continue
        if skipping:
            if not line.strip():
                skipping = False
                continue
            if line.lstrip().startswith("-"):
                continue
            skipping = False
        out.append(line)
    return "\n".join(out)


def sanitize_text_block(text: str) -> str:
    """Remove workflow state, routing hints, and structured payloads from any text."""
    if not text:
        return ""
    out = str(text)
    out = _strip_live_call_state_block(out)
    out = _TOOL_ROUTING_LINE.sub("", out)
    out = _INTERNAL_STATE_LINE.sub("", out)
    out = _STRUCTURED_JSON_PATTERN.sub("", out)
    out = _SHOPIFY_GID_PATTERN.sub("", out)
    out = _WORKFLOW_PATTERN.sub("", out)
    out = _VARIANT_ID_PATTERN.sub("", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    out = re.sub(r"[ \t]+\n", "\n", out)
    return out.strip()


def build_conversation_summary_for_llm(session: Any) -> str:
    """
    Non-structured conversation summary only — no workflow flags or tool metadata.
    """
    try:
        from ..conversation.call_memory import get_call_memory, sync_from_session

        sync_from_session(session)
        state = get_call_memory(session)
    except Exception:  # noqa: BLE001
        return ""

    parts: list[str] = []
    if state.rolling_summary:
        parts.append(sanitize_text_block(state.rolling_summary))

    for ut in state.user_turns[-6:]:
        line = sanitize_user_text(ut)
        if line:
            parts.append(f"Customer said: {line}")
    for at in state.assistant_turns[-4:]:
        line = sanitize_text_block(at)
        if line:
            parts.append(f"Agent said: {line}")

    combined = "\n".join(parts).strip()
    return sanitize_text_block(combined)


def sanitize_tool_output_content(tool_name: str, raw: str) -> str:
    """
    Replace raw tool JSON with customer-safe natural language only.
    """
    name = (tool_name or "").strip()
    try:
        data = json.loads(raw or "")
    except json.JSONDecodeError:
        return sanitize_text_block((raw or "")[:400])

    if not isinstance(data, dict):
        return sanitize_text_block(str(data)[:400])

    for key in ("customer_message", "message", "spoken_reply", "summary"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return sanitize_text_block(val.strip())

    if name in _STRUCTURED_TOOL_NAMES or name.startswith("search_"):
        if data.get("not_found") or data.get("found") is False:
            return "No matching catalog item was found."
        if data.get("found") or data.get("count"):
            return "A catalog item was found."
        return "A catalog lookup completed."

    if "order" in name.lower() or data.get("order_number"):
        if data.get("found"):
            return "Order details were retrieved."
        return "No matching order was found."

    return "Information was retrieved."


def sanitize_llm_input(
    messages: list[dict[str, Any]],
    *,
    static_system_prompt: str = "",
) -> list[dict[str, Any]]:
    """
    Return messages safe for the LLM — no workflow state or raw tool payloads.

    Preserves tool-call protocol messages when present but sanitizes their content.
  """
    clean: list[dict[str, Any]] = []

    for msg in messages:
        role = str(msg.get("role") or "")
        if role not in _VALID_ROLES:
            continue

        if role == "system":
            content = sanitize_text_block(str(msg.get("content") or ""))
            if content:
                clean.append({"role": "system", "content": content})
            continue

        if role == "tool":
            content = sanitize_tool_output_content(
                str(msg.get("tool_name") or ""),
                str(msg.get("content") or ""),
            )
            if not msg.get("tool_call_id"):
                continue
            clean.append({
                "role": "tool",
                "tool_call_id": msg["tool_call_id"],
                "content": content,
            })
            continue

        if role == "assistant":
            entry: dict[str, Any] = {"role": "assistant"}
            if msg.get("content"):
                entry["content"] = sanitize_text_block(str(msg["content"]))
            if msg.get("tool_calls"):
                entry["tool_calls"] = msg["tool_calls"]
            if entry.get("content") or entry.get("tool_calls"):
                clean.append(entry)
            continue

        # user
        content = sanitize_user_text(str(msg.get("content") or ""))
        if content:
            clean.append({"role": "user", "content": content})

    return clean


def sanitize_support_llm_user_content(
    *,
    issue_title: str = "",
    issue_detail: str = "",
    customer_name: str = "",
    transcript: str = "",
) -> str:
    """Support summarization LLM — transcript prose only, no API/workflow context."""
    parts = []
    if issue_title.strip():
        parts.append(f"Issue: {sanitize_text_block(issue_title.strip())}")
    if issue_detail.strip():
        parts.append(f"Detail: {sanitize_text_block(issue_detail.strip())}")
    if customer_name.strip():
        parts.append(f"Customer name: {sanitize_text_block(customer_name.strip())}")
    if transcript.strip():
        parts.append(f"Transcript:\n{sanitize_text_block(transcript)}")
    else:
        parts.append("Transcript:\n(no transcript yet)")
    return "\n\n".join(parts)
