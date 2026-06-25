"""
Parallel Shopify order enrichment for live voice calls (v4.32).

When an order number is verified, fetch order status, refund history, and
optional facility restriction review concurrently — not sequentially.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


@dataclass
class OrderEnrichmentResult:
    order_number: str = ""
    order: dict[str, Any] = field(default_factory=dict)
    refund: dict[str, Any] = field(default_factory=dict)
    facility: dict[str, Any] = field(default_factory=dict)
    verified: bool = False
    suggested_response: str = ""


def _parse_json(raw: str) -> dict[str, Any]:
    try:
        data = json.loads(raw or "{}")
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def compose_order_voice_reply(
    order: dict[str, Any],
    refund: dict[str, Any],
    *,
    facility: dict[str, Any] | None = None,
) -> str:
    """Build a phone-friendly summary from parallel tool payloads."""
    if order.get("suggested_response"):
        base = order["suggested_response"]
    elif order.get("found"):
        base = (
            f"Order {order.get('order_number', '')} is {order.get('status', 'unknown')} "
            f"with fulfillment {order.get('fulfillment_status', 'unknown')}."
        )
        if order.get("tracking_number"):
            base += f" Tracking number is {order['tracking_number']}."
    elif order.get("message"):
        base = order["message"]
    else:
        base = "I couldn't find that order with the details provided."

    if refund.get("suggested_response"):
        base += " " + refund["suggested_response"]
    elif refund.get("refund_count"):
        base += f" There are {refund['refund_count']} refund(s) on this order."

    if facility:
        msg = (
            facility.get("customer_message")
            or facility.get("message")
            or facility.get("safe_summary")
            or ""
        )
        if msg:
            base += " " + msg
        url = facility.get("website_url") or ""
        if url and url not in base:
            base += f" Facility guidelines: {url}."

    return base.strip()


async def enrich_order_parallel(
    session: "SessionState",
    order_number: str,
    *,
    email: str | None = None,
    phone: str | None = None,
    facility_name: str = "",
    check_facility: bool = False,
) -> OrderEnrichmentResult:
    """
    Fetch order + refund (+ optional facility restrictions) in parallel.
    """
    from ..tools.shopify_tools import get_refund_status, lookup_order

    order_number = (order_number or "").lstrip("#").strip()
    if not order_number:
        return OrderEnrichmentResult(suggested_response="I need an order number to look that up.")

    if not phone and getattr(session, "from_number", ""):
        phone = session.from_number
    if not email and getattr(session, "caller_email", "") and getattr(session, "verified_email", False):
        email = session.caller_email

    order_task = lookup_order(
        order_number=order_number,
        email=email,
        phone=phone,
        session=session,
    )
    refund_task = get_refund_status(
        order_number=order_number,
        email=email,
        phone=phone,
        session=session,
    )

    facility_task = None
    if check_facility and order_number:
        from ..facility.order_reconciliation import reconcile_order_facility_json

        facility_task = reconcile_order_facility_json(
            session,
            order_number,
            facility_name,
        )

    if facility_task:
        raw_order, raw_refund, raw_facility = await asyncio.gather(
            order_task, refund_task, facility_task, return_exceptions=True,
        )
    else:
        raw_order, raw_refund = await asyncio.gather(
            order_task, refund_task, return_exceptions=True,
        )
        raw_facility = ""

    order = _parse_json(raw_order if not isinstance(raw_order, Exception) else "{}")
    refund = _parse_json(raw_refund if not isinstance(raw_refund, Exception) else "{}")
    facility = _parse_json(raw_facility if isinstance(raw_facility, str) else "{}")

    if isinstance(raw_order, Exception):
        logger.warning("order_enrich_order_failed sid=%s err=%s", session.call_sid[:6], raw_order)
    if isinstance(raw_refund, Exception):
        logger.warning("order_enrich_refund_failed sid=%s err=%s", session.call_sid[:6], raw_refund)

    verified = bool(
        order.get("found")
        and (order.get("items") or order.get("email_masked") or order.get("payment_card_last4"))
    )

    session.last_order_number = order.get("order_number") or order_number
    if facility_name:
        session.last_facility_name = facility_name

    try:
        from ..conversation.call_memory import extract_durable_facts

        extract_durable_facts(session, f"order {order_number}")
    except Exception:  # noqa: BLE001
        pass

    reply = compose_order_voice_reply(order, refund, facility=facility or None)
    if order.get("found") and not verified:
        reply = (
            f"I found order {order.get('order_number', order_number)} — "
            f"status is {order.get('status', 'unknown')} and fulfillment is "
            f"{order.get('fulfillment_status', 'unknown')}. "
            "To share full details including tracking and refunds, please confirm the "
            "email or phone number on the order."
        )

    logger.info(
        "order_parallel_enrichment sid=%s order=%s verified=%s facility=%s",
        session.call_sid[:6],
        order_number,
        verified,
        bool(facility),
    )

    return OrderEnrichmentResult(
        order_number=order_number,
        order=order,
        refund=refund,
        facility=facility,
        verified=verified,
        suggested_response=reply,
    )
