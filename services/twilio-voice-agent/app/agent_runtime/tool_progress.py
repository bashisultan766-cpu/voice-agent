"""
No-silence progress prompts during slow LLM tool calls (v4.25).

Sends real ConversationRelay tokens when tool work exceeds the progress threshold.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING, Awaitable, Callable, Optional

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

TOOL_PROGRESS_ENABLED = True
TOOL_PROGRESS_AFTER_MS = 400

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
    "check_order_facility_restrictions",
    "reconcile_order_facility_books",
    "send_payment_link",
    "add_to_cart",
    "create_checkout",
})

_PROGRESS_PHRASES: dict[str, str] = {
    "search_products": "One moment — checking our catalog.",
    "catalog_search": "One moment — checking our catalog.",
    "get_product_details": "Pulling that up now.",
    "compare_products": "Comparing those for you.",
    "lookup_order_status": "One moment — looking up your order.",
    "lookup_refund_status": "Checking on that refund.",
    "get_order": "One moment — looking up your order.",
    "calculate_pricing": "Working out the pricing.",
    "lookup_customer_by_email_or_phone": "Verifying that email.",
    "check_facility_approval": "Checking facility approval.",
    "check_order_facility_restrictions": "Reviewing facility rules for that order.",
    "reconcile_order_facility_books": "Matching your order against facility guidelines.",
    "send_payment_link": "Preparing your secure payment link.",
    "add_to_cart": "Adding that to your cart.",
    "create_checkout": "Setting up your payment link.",
}


def progress_phrase_for_tool(name: str) -> Optional[str]:
    return _PROGRESS_PHRASES.get(name)


def is_slow_tool(name: str) -> bool:
    return name in _SLOW_TOOLS


def _progress_delay_ms(settings) -> int:
    env_ms = getattr(settings, "VOICE_TOOL_PROGRESS_AFTER_MS", None)
    if env_ms is not None:
        return max(0, int(env_ms))
    filler = int(getattr(settings, "VOICE_FILLER_AFTER_MS", 250) or 250)
    return max(TOOL_PROGRESS_AFTER_MS, filler)


def _should_skip_progress(session: "SessionState | None", op_key: str) -> Optional[str]:
    if session is None:
        return None
    if getattr(session, "voice_interrupted", False):
        return "interrupted"
    if getattr(session, "turn_taking_hold", False):
        return "caller_speaking"
    sent_for = getattr(session, "tool_progress_sent_for_op", "") or ""
    if sent_for == op_key:
        return "already_sent"
    return None


async def dispatch_with_progress(
    dispatch_fn: Callable[..., Awaitable[str]],
    name: str,
    args: dict,
    session: "SessionState | None",
    send: Optional[Callable],
    settings,
    sid: str,
) -> str:
    """Run tool dispatch; speak one progress phrase if work exceeds threshold."""
    if not TOOL_PROGRESS_ENABLED or not is_slow_tool(name) or send is None:
        return await dispatch_fn(name, args, session)

    op_key = f"{name}:{time.monotonic():.3f}"
    skip = _should_skip_progress(session, op_key)
    if skip:
        logger.info(
            "tool_progress_prompt_skipped sid=%s tool=%s reason=%s",
            sid, name, skip,
        )
        return await dispatch_fn(name, args, session)

    delay_s = _progress_delay_ms(settings) / 1000
    started = time.monotonic()
    task = asyncio.create_task(dispatch_fn(name, args, session), name=f"tool-{name}")
    progress_sent = False

    while not task.done():
        elapsed_ms = (time.monotonic() - started) * 1000
        if elapsed_ms >= delay_s and not progress_sent:
            phrase = progress_phrase_for_tool(name)
            if phrase:
                skip_now = _should_skip_progress(session, op_key)
                if skip_now:
                    logger.info(
                        "tool_progress_prompt_skipped sid=%s tool=%s reason=%s",
                        sid, name, skip_now,
                    )
                else:
                    await _send_progress(send, phrase)
                    progress_sent = True
                    if session is not None:
                        session.tool_progress_sent_for_op = op_key
                    logger.info(
                        "tool_progress_prompt_sent sid=%s tool=%s phrase=%r elapsed_ms=%.0f",
                        sid, name, phrase, elapsed_ms,
                    )
            await asyncio.sleep(0.05)
        else:
            await asyncio.sleep(0.02)

    elapsed_total = (time.monotonic() - started) * 1000
    if not progress_sent and elapsed_total >= delay_s:
        logger.info(
            "tool_progress_prompt_skipped sid=%s tool=%s reason=fast_tool elapsed_ms=%.0f",
            sid, name, elapsed_total,
        )
    return task.result()


async def _send_progress(send: Callable, phrase: str) -> None:
    out = send({"type": "text", "token": phrase, "last": False, "interruptible": True})
    if asyncio.iscoroutine(out):
        await out
