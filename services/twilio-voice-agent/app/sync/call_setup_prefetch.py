"""
Best-effort call-setup cache warm — used when a ConversationRelay session starts.

Reads CustomerCache and OrderCache only (no live Shopify calls).
"""
from __future__ import annotations

import asyncio
import logging

from ..state.models import SessionState

logger = logging.getLogger(__name__)


async def _prefetch_customer(session: SessionState, cache) -> None:
    try:
        customer = await cache.get_by_phone(session.from_number)
        if customer and not session.caller_name:
            session.caller_name = customer.display_name
    except Exception:
        pass


async def _prefetch_recent_order(session: SessionState, cache) -> None:
    try:
        order = await cache.get_recent_by_phone(session.from_number)
        if order and not session.last_order_number:
            session.last_order_number = order.order_number
    except Exception:
        pass


async def prefetch_on_call_setup(session: SessionState) -> None:
    """
    Parallel prefetch at call setup. Never blocks or raises.
    """
    try:
        from .repositories import CustomerCache, OrderCache

        tasks = [
            asyncio.create_task(
                _prefetch_customer(session, CustomerCache()),
                name="setup-prefetch-customer",
            ),
            asyncio.create_task(
                _prefetch_recent_order(session, OrderCache()),
                name="setup-prefetch-order",
            ),
        ]
        await asyncio.gather(*tasks, return_exceptions=True)
    except Exception:
        logger.debug(
            "Call setup prefetch skipped (sync layer unavailable) sid=%s",
            session.call_sid[:6],
        )
