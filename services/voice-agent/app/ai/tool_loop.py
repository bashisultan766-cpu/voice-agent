import asyncio
import json
import logging
from typing import Any

from openai import AsyncOpenAI
from openai.types.chat import ChatCompletion

from .tools import registry as _v1_registry
from .tools.base import ToolContext as _V1Context
from ..tools import registry as _v2_registry
from ..tools.base import ToolContext, ToolResult
from ..state.schema import SessionState
from ..tenant.schema import AgentConfig
from ..config import get_settings


def _select_registry(agent_config: AgentConfig):
    """Return the appropriate tool registry based on agent configuration."""
    if agent_config.tool_version == "v2":
        return _v2_registry
    return _v1_registry


def _select_context_cls(agent_config: AgentConfig):
    """Return the ToolContext class matching the selected registry version."""
    if agent_config.tool_version == "v2":
        return ToolContext
    return _V1Context

logger = logging.getLogger(__name__)

MAX_ITERATIONS = 3


async def run_tool_loop(
    user_message: str,
    system_prompt: str,
    agent_config: AgentConfig,
    state: SessionState,
    openai_client: AsyncOpenAI,
) -> tuple[str, list[dict[str, Any]]]:
    """
    OpenAI tool-use loop, max 3 iterations, parallel tool execution.
    Returns (response_text, list_of_state_updates).
    """
    settings = get_settings()
    model = agent_config.openai_model or settings.OPENAI_MODEL

    active_registry = _select_registry(agent_config)
    ContextCls = _select_context_cls(agent_config)

    context = ContextCls(
        session_id=state.session_id,
        agent_id=state.agent_id,
        call_sid=state.call_sid,
        from_number=state.from_number,
        agent_config=agent_config,
        session_state=state,
    )

    tools = active_registry.get_schemas(agent_config.enabled_tools)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt},
        *state.to_openai_messages(),
        {"role": "user", "content": user_message},
    ]

    state_updates: list[dict[str, Any]] = []

    for iteration in range(MAX_ITERATIONS):
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": 0.7,
            "max_tokens": 250,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        response: ChatCompletion = await openai_client.chat.completions.create(**kwargs)
        choice = response.choices[0]

        # No tool calls → final response
        if not choice.message.tool_calls:
            return choice.message.content or "", state_updates

        # Build assistant message with tool calls
        messages.append({
            "role": "assistant",
            "content": choice.message.content,
            "tool_calls": [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in choice.message.tool_calls
            ],
        })

        # Execute all tool calls in parallel
        tool_tasks = [
            _execute_tool(tc.function.name, tc.function.arguments, context, active_registry)
            for tc in choice.message.tool_calls
        ]
        results: list[tuple[ToolResult, dict]] = await asyncio.gather(*tool_tasks)

        # Append tool result messages
        for tc, (tool_result, raw_data) in zip(choice.message.tool_calls, results):
            if tool_result.state_update:
                state_updates.append(tool_result.state_update)
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": json.dumps(raw_data),
            })

        logger.debug("Tool loop iteration %d: %d tool calls", iteration + 1, len(results))

    # Max iterations reached — force a plain response
    messages.append({
        "role": "system",
        "content": "Based on everything above, give a short, direct response to the caller.",
    })
    final = await openai_client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.7,
        max_tokens=150,
    )
    return final.choices[0].message.content or "", state_updates


async def _execute_tool(
    tool_name: str,
    arguments_json: str,
    context: ToolContext,
    active_registry=None,
) -> tuple[ToolResult, dict]:
    if active_registry is None:
        active_registry = _v1_registry
    tool = active_registry.get(tool_name)
    if tool is None:
        logger.warning("Unknown tool requested: %s", tool_name)
        result = ToolResult(
            success=False,
            data={},
            voice_summary="",
            error=f"Tool '{tool_name}' not found",
        )
        return result, {"error": result.error}

    try:
        args = json.loads(arguments_json)
        result = await tool.execute(args, context)
        logger.debug("Tool %s → success=%s", tool_name, result.success)
        return result, result.data
    except Exception as exc:
        logger.error("Tool %s raised: %s", tool_name, exc, exc_info=True)
        result = ToolResult(
            success=False,
            data={},
            voice_summary="I ran into an issue looking that up. Let me try again.",
            error=str(exc),
        )
        return result, {"error": str(exc)}
