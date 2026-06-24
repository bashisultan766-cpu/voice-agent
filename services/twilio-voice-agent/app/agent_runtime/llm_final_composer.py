"""
LLM final response composer (v4.17).

After any tool execution the LLM — never a raw worker string — owns the final
spoken response. This module takes the current cart/commerce state, durable
memory facts, and the tool results, and asks the LLM to write one short,
natural, sales-oriented, phone-friendly reply.

A deterministic `fallback_text` (already grounded in the same state + facts) is
always provided so the caller is never left in silence when the model is slow,
errors, or is unavailable (e.g. a test API key). The deterministic text is also
what guarantees the exact professional sales phrasing the policy requires.

Logging (no secrets, no PII):
  llm_final_response_started   sid=... intent=...
  llm_final_response_completed sid=... chars=... tokens=... source=llm|fallback
"""
from __future__ import annotations

import asyncio
import logging
import math
from typing import Any, Optional

logger = logging.getLogger(__name__)

_TEST_KEYS = frozenset({"", "test", "test-key", "sk-test", "dummy"})


def _looks_like_test_key(api_key: str) -> bool:
    return (api_key or "").strip().lower() in _TEST_KEYS


def _estimate_tokens(text: str) -> int:
    # Rough heuristic — ~4 chars/token — used only for observability logs.
    return max(1, math.ceil(len(text or "") / 4))


async def compose_final_response(
    *,
    session,
    sid: str,
    caller_text: str,
    intent: str,
    fallback_text: str,
    commerce_state: Any,
    memory_facts: Optional[list[str]] = None,
    tool_results: Optional[dict[str, Any]] = None,
    settings: Any,
) -> str:
    """
    Produce the final spoken response.

    The LLM is the author of record. When the LLM is unavailable, the
    deterministic, state-grounded `fallback_text` is returned so the spoken
    reply is always natural and never a raw worker/tool string.
    """
    logger.info("llm_final_response_started sid=%s intent=%s", (sid or "")[:6], intent)

    text = (fallback_text or "").strip()
    source = "fallback"

    enabled = bool(getattr(settings, "VOICE_LLM_FINAL_COMPOSE", True))
    api_key = getattr(settings, "OPENAI_API_KEY", "")
    if enabled and not _looks_like_test_key(api_key):
        try:
            llm_text = await _call_llm(
                caller_text=caller_text,
                intent=intent,
                fallback_text=text,
                commerce_state=commerce_state,
                memory_facts=memory_facts or [],
                tool_results=tool_results or {},
                settings=settings,
            )
            if llm_text:
                text = llm_text
                source = "llm"
        except Exception:  # noqa: BLE001 — never let composition break the call
            logger.warning("llm_final_response_error sid=%s — using fallback", (sid or "")[:6])

    if not text:
        text = "How can I help you with SureShot Books today?"

    logger.info(
        "llm_final_response_completed sid=%s chars=%d tokens=%d source=%s",
        (sid or "")[:6],
        len(text),
        _estimate_tokens(text),
        source,
    )
    return text


def _build_state_context(commerce_state: Any) -> str:
    try:
        summary = commerce_state.to_summary_dict()
    except Exception:  # noqa: BLE001
        return ""
    parts: list[str] = []
    if summary.get("current_candidate"):
        parts.append(f"Current book being discussed: {summary['current_candidate']}")
        if summary.get("last_selected_price"):
            parts.append(f"Current book price: {summary['last_selected_price']}")
    if summary.get("selected_candidates"):
        parts.append("Books the caller selected but not yet confirmed: "
                     + ", ".join(summary["selected_candidates"]))
    if summary.get("cart_lines"):
        parts.append("Books already in the order: " + ", ".join(summary["cart_lines"]))
    parts.append(f"Cart line count: {summary.get('cart_count', 0)}")
    if summary.get("pending_action"):
        parts.append(f"Pending action: {summary['pending_action']}")
    return "\n".join(parts)


async def _call_llm(
    *,
    caller_text: str,
    intent: str,
    fallback_text: str,
    commerce_state: Any,
    memory_facts: list[str],
    tool_results: dict[str, Any],
    settings: Any,
) -> str:
    from openai import AsyncOpenAI

    model = getattr(settings, "VOICE_FINAL_MODEL", "gpt-4o-mini")
    timeout = getattr(settings, "VOICE_FINAL_TIMEOUT_MS", 4000) / 1000

    system = (
        "You are Eric, the friendly SureShot Books phone sales agent. "
        "You own the conversation. Use ONLY the facts provided (cart, selected "
        "books, current book, tool results, memory) — never invent prices, stock, "
        "or titles. Write ONE short, natural, phone-friendly, sales-oriented "
        "reply. Ask exactly one question. No JSON, no markdown, no lists. "
        "If a book was found, confirm it and offer to add it or look up another. "
        "Never say robotic phrases like 'What item would you like to order first?' "
        "when a book is already being discussed."
    )

    state_ctx = _build_state_context(commerce_state)
    facts_ctx = "; ".join((memory_facts or [])[-12:])
    tool_ctx_parts: list[str] = []
    for name, data in (tool_results or {}).items():
        tool_ctx_parts.append(f"{name}: {data}")
    tool_ctx = "\n".join(tool_ctx_parts)

    user = (
        f"Caller said: {caller_text}\n"
        f"Detected intent: {intent}\n\n"
        f"Commerce state:\n{state_ctx}\n\n"
        f"Memory facts: {facts_ctx}\n\n"
        f"Tool results:\n{tool_ctx}\n\n"
        f"A safe grounded draft you may improve (keep its meaning and any prices/"
        f"titles exactly): {fallback_text}\n\n"
        "Write Eric's single spoken reply now."
    )

    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    resp = await asyncio.wait_for(
        client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.6,
            max_tokens=120,
        ),
        timeout=timeout,
    )
    return (resp.choices[0].message.content or "").strip()
