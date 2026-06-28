"""
Parallel Shopify order enrichment for live voice calls (v4.32).

When an order number is spoken, fetch full order details (+ optional facility review).
"""
from __future__ import annotations

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
    """Build a phone-friendly summary from tool payloads."""
    if order.get("customer_message"):
        base = str(order["customer_message"])
    elif order.get("suggested_response"):
        base = str(order["suggested_response"])
    elif order.get("found"):
        base = (
            f"Order {order.get('order_number', '')} is {order.get('status', 'unknown')} "
            f"with fulfillment {order.get('fulfillment_status', 'unknown')}."
        )
        if order.get("tracking_number"):
            base += f" Tracking number is {order['tracking_number']}."
    elif order.get("message"):
        base = order["message"]
    elif not order.get("found") and order.get("customer_message"):
        base = str(order["customer_message"])
    else:
        base = "I couldn't find that order with the details provided."

    if refund.get("suggested_response") and refund.get("suggested_response") not in base:
        base += " " + str(refund["suggested_response"])
    elif refund.get("refund_count"):
        base += f" There are {refund['refund_count']} refund(s) on this order."

    if facility:
        msg = (
            facility.get("customer_message")
            or facility.get("message")
            or facility.get("safe_summary")
            or ""
        )
        if msg and msg not in base:
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
    Fetch full order details by order number (optional email/phone filters).
    """
    from ..tools.shopify_tools import get_refund_status, lookup_shopify_order_details

    order_number = (order_number or "").lstrip("#").strip()
    if not order_number:
        return OrderEnrichmentResult(suggested_response="I need an order number to look that up.")

    email_or_phone = email or phone or None

    order_task = lookup_shopify_order_details(
        order_number,
        email_or_phone=email_or_phone,
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

    import asyncio

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

    session.last_order_number = (
        (order.get("order") or {}).get("order_number")
        or order.get("order_number")
        or order_number
    )
    if facility_name:
        session.last_facility_name = facility_name

    try:
        from ..conversation.call_memory import extract_durable_facts

        extract_durable_facts(session, f"order {order_number}")
    except Exception:  # noqa: BLE001
        pass

    reply = compose_order_voice_reply(order, refund, facility=facility or None)
    if not reply and order.get("found"):
        reply = order.get("customer_message") or "I found your order."

    logger.info(
        "order_parallel_enrichment sid=%s order=%s found=%s facility=%s",
        session.call_sid[:6],
        order_number,
        bool(order.get("found")),
        bool(facility),
    )

    return OrderEnrichmentResult(
        order_number=order_number,
        order=order,
        refund=refund,
        facility=facility,
        verified=bool(order.get("found")),
        suggested_response=reply,
    )
