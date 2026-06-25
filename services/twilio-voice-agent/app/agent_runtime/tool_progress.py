"""
No-silence progress prompts during slow LLM tool calls (v4.24).

Races tool dispatch against VOICE_FILLER_AFTER_MS and speaks a short progress
phrase if the backend has not returned yet — same pattern as pipeline/engine.py.
"""
from __future__ import annotations

import asyncio
import logging
import random
from typing import TYPE_CHECKING, Awaitable, Callable, Optional

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

TOOL_PROGRESS_ENABLED = True

_SLOW_TOOLS = frozenset({
    "search_products",
    "catalog_search",
    "get_product_details",
    "compare_products",
    "lookup_order_status",
    "lookup_refund_status",
    "get_order",
    "calculate_pricing",
    "lookup_customer_by_email_or_phone",
    "check_facility_approval",
    "send_payment_link",
})

_PROGRESS_PHRASES: dict[str, list[str]] = {
    "search_products": [
        "Let me search the catalog for that.",
        "One moment while I look that up.",
    ],
    "catalog_search": [
        "Let me search the catalog for that.",
        "One moment while I check our inventory.",
    ],
    "get_product_details": [
        "Let me pull up the details on that book.",
        "One moment while I look that up.",
    ],
    "compare_products": [
        "Let me compare those books for you.",
        "One moment while I check both titles.",
    ],
    "lookup_order_status": [
        "Sure, let me pull up that order.",
        "One moment while I look up your order.",
    ],
    "lookup_refund_status": [
        "Let me check on that refund for you.",
        "One moment while I look into the refund status.",
    ],
    "get_order": [
        "Let me pull up that order.",
        "One moment while I look that up.",
    ],
    "calculate_pricing": [
        "Let me calculate that for you.",
        "One moment while I check the pricing.",
    ],
    "lookup_customer_by_email_or_phone": [
        "Let me look up your account.",
        "One moment while I check that.",
    ],
    "check_facility_approval": [
        "Let me check facility approval for that.",
        "One moment while I look that up.",
    ],
    "send_payment_link": [
        "Let me send that payment link to your email.",
        "One moment while I prepare your payment link.",
    ],
}


def progress_phrase_for_tool(name: str) -> Optional[str]:
    phrases = _PROGRESS_PHRASES.get(name)
    return random.choice(phrases) if phrases else None


def is_slow_tool(name: str) -> bool:
    return name in _SLOW_TOOLS


async def dispatch_with_progress(
    dispatch_fn: Callable[..., Awaitable[str]],
    name: str,
    args: dict,
    session: "SessionState | None",
    send: Optional[Callable],
    settings,
    sid: str,
) -> str:
    """Run tool dispatch; speak a progress phrase if the call exceeds the filler delay."""
    if not TOOL_PROGRESS_ENABLED or not is_slow_tool(name) or send is None:
        return await dispatch_fn(name, args, session)

    delay_s = max(0.0, getattr(settings, "VOICE_FILLER_AFTER_MS", 250) / 1000)
    task = asyncio.create_task(dispatch_fn(name, args, session), name=f"tool-{name}")

    if delay_s <= 0:
        phrase = progress_phrase_for_tool(name)
        if phrase:
            await _send_progress(send, phrase)
            logger.info("tool_progress_prompt sid=%s tool=%s immediate=true", sid, name)
        return await task

    done, _pending = await asyncio.wait({task}, timeout=delay_s)
    if task in done:
        return task.result()

    phrase = progress_phrase_for_tool(name)
    if phrase:
        await _send_progress(send, phrase)
        logger.info("tool_progress_prompt sid=%s tool=%s delay_ms=%d", sid, name, int(delay_s * 1000))
    return await task


async def _send_progress(send: Callable, phrase: str) -> None:
    out = send({"type": "text", "token": phrase, "last": False, "interruptible": True})
    if asyncio.iscoroutine(out):
        await out
