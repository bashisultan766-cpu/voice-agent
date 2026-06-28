"""
Parallel Shopify order enrichment for live voice calls (v4.32).

When an order number is spoken, fetch full order details (+ optional facility review).
Tool returns JSON only — short-circuit uses a minimal structured fallback if needed.
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


def _minimal_order_fallback(order_payload: dict[str, Any]) -> str:
    """Thin fallback when brain is skipped — not a substitute for LLM formatting."""
    if not order_payload.get("found"):
        code = order_payload.get("error_code") or order_payload.get("error") or ""
        if code == "order_not_found":
            return "I couldn't find that order in Shopify."
        return "I couldn't look up that order right now."

    inner = order_payload.get("order") or {}
    num = inner.get("order_number") or order_payload.get("order_number") or ""
    name = inner.get("customer_name") or ""
    parts = ["I found your order."]
    if num:
        parts.append(f"Order {num}.")
    if name:
        parts.append(f"It's under {name}.")
    return " ".join(parts)


def compose_order_voice_reply(
    order: dict[str, Any],
    refund: dict[str, Any],
    *,
    facility: dict[str, Any] | None = None,
) -> str:
    """Minimal fallback reply from structured tool JSON (LLM should format when possible)."""
    base = _minimal_order_fallback(order)

    if facility:
        msg = (
            facility.get("message")
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
    Fetch full order details by order number (single Shopify tool call + optional facility).
    """
    from ..tools.shopify_tools import lookup_shopify_order_details

    order_number = (order_number or "").lstrip("#").strip()
    if not order_number:
        return OrderEnrichmentResult(suggested_response="I need an order number to look that up.")

    email_or_phone = email or phone or None

    order_task = lookup_shopify_order_details(
        order_number,
        email_or_phone=email_or_phone,
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
        raw_order, raw_facility = await asyncio.gather(
            order_task, facility_task, return_exceptions=True,
        )
    else:
        raw_order = await order_task
        raw_facility = ""

    order = _parse_json(raw_order if not isinstance(raw_order, Exception) else "{}")
    refund: dict[str, Any] = {}
    facility = _parse_json(raw_facility if isinstance(raw_facility, str) else "{}")

    if isinstance(raw_order, Exception):
        logger.warning("order_enrich_order_failed sid=%s err=%s", session.call_sid[:6], raw_order)

    inner = order.get("order") or {}
    session.last_order_number = (
        inner.get("order_number")
        or order.get("order_number")
        or order_number
    )
    if facility_name:
        session.last_facility_name = facility_name

    if order.get("found") and inner:
        session.order_context = json.dumps(inner)[:2000]

    try:
        from ..conversation.call_memory import extract_durable_facts

        extract_durable_facts(session, f"order {order_number}")
    except Exception:  # noqa: BLE001
        pass

    reply = compose_order_voice_reply(order, refund, facility=facility or None)

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
