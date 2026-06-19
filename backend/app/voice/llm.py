from __future__ import annotations
import asyncio
import json
from typing import Any, Dict, List, Optional
import openai
from app.config import settings


async def run_llm_with_tools(
    messages: List[Dict[str, Any]],
    tool_schemas: List[Dict[str, Any]],
    model: str,
    api_key: Optional[str] = None,
    max_iterations: int = 8,
) -> tuple[str, List[Dict[str, Any]]]:
    """
    Run an OpenAI LLM with tool-calling loop.
    Returns (final_text_response, tool_call_log).
    """
    key = api_key or settings.OPENAI_API_KEY
    client = openai.AsyncOpenAI(api_key=key)

    conversation = list(messages)
    tool_call_log: List[Dict[str, Any]] = []

    for _ in range(max_iterations):
        kwargs: Dict[str, Any] = {
            "model": model,
            "messages": conversation,
            "temperature": 0.35,
            "max_tokens": 280,
        }
        if tool_schemas:
            kwargs["tools"] = tool_schemas
            kwargs["tool_choice"] = "auto"

        response = await client.chat.completions.create(**kwargs)
        msg = response.choices[0].message

        if msg.tool_calls:
            conversation.append(msg.model_dump(exclude_unset=True))
            tool_call_log.append({"tool_calls": [tc.model_dump() for tc in msg.tool_calls]})
            # Caller must resolve tool calls and append results; we signal via sentinel
            return "__TOOL_CALLS__", tool_call_log

        text = msg.content or ""
        conversation.append({"role": "assistant", "content": text})
        return text, tool_call_log

    return "I'm sorry, I wasn't able to complete that request. Can I help you with something else?", []


async def run_agentic_loop(
    system_prompt: str,
    conversation_history: List[Dict[str, Any]],
    user_message: str,
    tool_schemas: List[Dict[str, Any]],
    tool_executor,  # async callable(name, args) -> str
    model: str = "gpt-4o-mini",
    api_key: Optional[str] = None,
    max_iterations: int = 8,
) -> tuple[str, List[Dict[str, Any]]]:
    """
    Full agentic loop with tool resolution.
    Returns (final_response_text, tool_call_log).
    """
    key = api_key or settings.OPENAI_API_KEY
    client = openai.AsyncOpenAI(api_key=key)

    messages: List[Dict[str, Any]] = [
        {"role": "system", "content": system_prompt},
        *conversation_history,
        {"role": "user", "content": user_message},
    ]

    all_tool_calls: List[Dict[str, Any]] = []

    for iteration in range(max_iterations):
        kwargs: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": 0.35,
            "max_tokens": 280,
        }
        if tool_schemas:
            kwargs["tools"] = tool_schemas
            kwargs["tool_choice"] = "auto"

        response = await client.chat.completions.create(**kwargs)
        msg = response.choices[0].message

        # If the LLM wants to call tools, execute them in parallel
        if msg.tool_calls:
            messages.append({
                "role": "assistant",
                "content": msg.content,
                "tool_calls": [tc.model_dump() for tc in msg.tool_calls],
            })

            # Execute all tool calls concurrently
            async def _exec(tc: Any) -> Dict[str, Any]:
                name = tc.function.name
                args = json.loads(tc.function.arguments or "{}")
                result = await tool_executor(name, args)
                return {"tool_call_id": tc.id, "name": name, "result": result}

            results = await asyncio.gather(*[_exec(tc) for tc in msg.tool_calls])

            for r in results:
                messages.append({
                    "role": "tool",
                    "tool_call_id": r["tool_call_id"],
                    "content": r["result"],
                })
                all_tool_calls.append(r)
            continue

        # Final text response
        return (msg.content or "").strip(), all_tool_calls

    return "I apologize, I'm having trouble right now. Please try again.", all_tool_calls
