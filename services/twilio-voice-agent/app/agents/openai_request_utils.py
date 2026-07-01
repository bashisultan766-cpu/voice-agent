"""
Safe OpenAI request diagnostics — never logs secrets or full PII.
"""
from __future__ import annotations

import json
import re
from typing import Any

_VALID_ROLES = frozenset({"system", "user", "assistant", "tool"})


def _safe_error_message(error: BaseException) -> str:
    """Extract a short, non-secret error message from an OpenAI exception."""
    body = getattr(error, "body", None)
    if isinstance(body, dict):
        err = body.get("error") or {}
        if isinstance(err, dict) and err.get("message"):
            msg = str(err["message"])
        else:
            msg = str(error)
    else:
        msg = str(error)
    # Strip anything that looks like an API key.
    msg = re.sub(r"sk-[A-Za-z0-9_-]{10,}", "sk-***", msg)
    return msg[:500]


def _find_invalid_schema_properties(schema: dict, path: str = "") -> list[str]:
    issues: list[str] = []
    if not isinstance(schema, dict):
        return [f"{path}: not an object"]
    if schema.get("type") == "object":
        props = schema.get("properties", {})
        if not isinstance(props, dict):
            issues.append(f"{path}.properties: invalid")
        else:
            for key, val in props.items():
                if not isinstance(val, dict):
                    issues.append(f"{path}.properties.{key}: invalid {type(val).__name__}")
                else:
                    issues.extend(_find_invalid_schema_properties(val, f"{path}.properties.{key}"))
    elif schema.get("type") == "array":
        items = schema.get("items")
        if not isinstance(items, dict):
            issues.append(f"{path}.items: missing or invalid")
        else:
            issues.extend(_find_invalid_schema_properties(items, f"{path}.items"))
    return issues


def _find_invalid_message_roles(messages: list[dict]) -> list[str]:
    issues: list[str] = []
    for i, msg in enumerate(messages):
        role = msg.get("role", "")
        if role not in _VALID_ROLES:
            issues.append(f"message[{i}].role={role!r}")
        if role == "tool" and not msg.get("tool_call_id"):
            issues.append(f"message[{i}]: tool missing tool_call_id")
        if role == "assistant" and msg.get("tool_calls"):
            for j, tc in enumerate(msg["tool_calls"]):
                if not isinstance(tc, dict):
                    issues.append(f"message[{i}].tool_calls[{j}]: not dict")
                elif not tc.get("id"):
                    issues.append(f"message[{i}].tool_calls[{j}]: missing id")
    return issues


def format_openai_bad_request(
    error: BaseException,
    *,
    model: str = "",
    messages: list[dict] | None = None,
    tools: list[dict] | None = None,
) -> dict[str, Any]:
    """
    Build a safe diagnostic dict for OpenAI BadRequestError logging.

    Never includes API keys, full prompts, or customer PII.
    """
    messages = messages or []
    tools = tools or []

    tool_names: list[str] = []
    schema_issues: list[str] = []
    for spec in tools:
        fn = (spec.get("function") or {}) if isinstance(spec, dict) else {}
        name = fn.get("name", "")
        if name:
            tool_names.append(name)
        params = fn.get("parameters") or {}
        schema_issues.extend(_find_invalid_schema_properties(params, name or "tool"))

    dupes = [n for n in set(tool_names) if tool_names.count(n) > 1]

    role_issues = _find_invalid_message_roles(messages)

    # Detect non-serializable tool specs.
    serializable = True
    try:
        json.dumps(tools)
    except (TypeError, ValueError):
        serializable = False

    return {
        "error_type": type(error).__name__,
        "error_message": _safe_error_message(error),
        "model": model,
        "messages_count": len(messages),
        "tools_count": len(tools),
        "tool_names": tool_names[:50],
        "duplicate_tool_names": dupes,
        "invalid_tool_schema": schema_issues[:20],
        "invalid_message_roles": role_issues[:20],
        "tools_json_serializable": serializable,
        "status_code": getattr(error, "status_code", None) or getattr(
            getattr(error, "response", None), "status_code", None
        ),
    }


def log_openai_bad_request(
    logger: Any,
    error: BaseException,
    *,
    sid: str = "",
    purpose: str = "main_commerce_brain",
    model: str = "",
    messages: list[dict] | None = None,
    tools: list[dict] | None = None,
) -> dict[str, Any]:
    """Log safe BadRequest diagnostics and return the detail dict."""
    detail = format_openai_bad_request(error, model=model, messages=messages, tools=tools)
    logger.error(
        "openai_bad_request sid=%s purpose=%s model=%s messages=%d tools=%d "
        "dupes=%s schema_issues=%d role_issues=%d serializable=%s msg=%r",
        (sid or "")[:6],
        purpose,
        detail["model"],
        detail["messages_count"],
        detail["tools_count"],
        detail["duplicate_tool_names"] or "none",
        len(detail["invalid_tool_schema"]),
        len(detail["invalid_message_roles"]),
        detail["tools_json_serializable"],
        detail["error_message"][:120],
    )
    if detail["invalid_tool_schema"]:
        logger.error(
            "openai_bad_request_schema sid=%s issues=%s",
            (sid or "")[:6],
            detail["invalid_tool_schema"][:5],
        )
    return detail


def repair_incomplete_tool_turns(messages: list[dict]) -> list[dict]:
    """
    Drop assistant tool_calls that lack matching tool responses.

    OpenAI rejects histories where an assistant message has tool_calls not
    followed by a tool message for every call id.
    """
    result: list[dict] = []
    i = 0
    while i < len(messages):
        msg = messages[i]
        if msg.get("role") == "assistant" and msg.get("tool_calls"):
            tool_ids = {
                tc.get("id")
                for tc in msg["tool_calls"]
                if isinstance(tc, dict) and tc.get("id")
            }
            j = i + 1
            found_ids: set[str] = set()
            while j < len(messages) and messages[j].get("role") == "tool":
                tid = messages[j].get("tool_call_id")
                if tid:
                    found_ids.add(tid)
                j += 1
            if tool_ids and tool_ids <= found_ids:
                result.extend(messages[i:j])
                i = j
            else:
                i = j if j > i + 1 else i + 1
        else:
            result.append(msg)
            i += 1
    return result


def rollback_interrupted_turn(messages: list[dict]) -> list[dict]:
    """Remove incomplete tool turns and the user prompt from a cancelled voice turn."""
    repaired = repair_incomplete_tool_turns(messages)
    while repaired and repaired[-1].get("role") == "user":
        repaired.pop()
    return repaired
