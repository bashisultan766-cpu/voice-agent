"""
Parallel turn prefetch for LLM-first runtime (v4.42).

Starts read-only Shopify work as soon as caller speech is prepared — before
the main OpenAI request — so tool results are warm when the LLM (or tools) run.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

TURN_PREFETCH_VERSION = "v4.43"


def _order_number_hint(session: "SessionState", caller_text: str, *, turn_mode: str = "") -> str:
    from .order_flow_state import extract_order_number

    order_num = (
        extract_order_number(caller_text, session, turn_mode=turn_mode)
        or getattr(session, "pending_order_number", "")
        or getattr(session, "last_order_number", "")
    )
    if order_num:
        return str(order_num).lstrip("#")
    if re.search(r"\border\b", caller_text or "", re.I):
        digits = "".join(c for c in caller_text if c.isdigit())
        if 4 <= len(digits) <= 8:
            return digits.lstrip("0") or digits
    return ""


def _catalog_query_hint(session: "SessionState", caller_text: str, *, turn_mode: str = "") -> str:
    isbn = (getattr(session, "last_resolved_isbn_for_turn", "") or "").strip()
    if isbn:
        return isbn
    from .isbn_short_circuit import normalize_catalog_search_query

    q, resolved = normalize_catalog_search_query(caller_text, session)
    return resolved or q.strip()


async def _prefetch_catalog(session: "SessionState", query: str) -> dict[str, Any]:
    from ..tools.shopify_tools import SureShotCatalogSearch

    raw = await SureShotCatalogSearch(query=query, limit=5)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


async def _prefetch_order(session: "SessionState", order_number: str) -> dict[str, Any]:
    from .order_parallel_enrichment import enrich_order_parallel

    result = await enrich_order_parallel(session, order_number)
    return {
        "order": result.order,
        "refund": result.refund,
        "facility": result.facility,
        "suggested_response": result.suggested_response,
        "verified": result.verified,
        "order_number": order_number,
    }


async def run_turn_prefetch(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
    max_wait_ms: int = 400,
) -> dict[str, Any]:
    """
    Run catalog and/or order prefetch in parallel; wait up to ``max_wait_ms``.
    """
    catalog_q = _catalog_query_hint(session, caller_text, turn_mode=turn_mode)
    order_num = _order_number_hint(session, caller_text, turn_mode=turn_mode)

    tasks: list[tuple[str, asyncio.Task]] = []
    if catalog_q and len(catalog_q) >= 10 and catalog_q.isdigit():
        tasks.append(("catalog", asyncio.create_task(_prefetch_catalog(session, catalog_q))))
    elif catalog_q and turn_mode == "isbn":
        tasks.append(("catalog", asyncio.create_task(_prefetch_catalog(session, catalog_q))))

    if order_num:
        tasks.append(("order", asyncio.create_task(_prefetch_order(session, order_num))))

    if not tasks:
        session.turn_prefetch_cache = {}
        return {}

    sid = (getattr(session, "call_sid", "") or "")[:6]
    logger.info(
        "turn_prefetch_start sid=%s catalog=%s order=%s",
        sid,
        bool(catalog_q),
        order_num or "none",
    )

    done, pending = await asyncio.wait(
        [t for _, t in tasks],
        timeout=max(0.05, max_wait_ms / 1000.0),
        return_when=asyncio.ALL_COMPLETED,
    )

    results: dict[str, Any] = {}
    for key, task in tasks:
        if task in done:
            try:
                val = task.result()
                if val:
                    results[key] = val
            except Exception as exc:  # noqa: BLE001
                logger.warning("turn_prefetch_failed sid=%s kind=%s err=%s", sid, key, exc)
        else:
            task.cancel()

    session.turn_prefetch_cache = results

    if results.get("catalog"):
        from .commerce_flow_state import maybe_stage_from_search_payload

        maybe_stage_from_search_payload(session, results["catalog"])

    order_payload = results.get("order") or {}
    order = order_payload.get("order") if isinstance(order_payload, dict) else {}
    if isinstance(order, dict) and order.get("found"):
        session.order_context = (
            order.get("suggested_response")
            or order_payload.get("suggested_response")
            or session.order_context
        )

    logger.info(
        "turn_prefetch_done sid=%s keys=%s waited_ms=%d pending=%d",
        sid,
        ",".join(results.keys()) or "none",
        max_wait_ms,
        len(pending),
    )
    return results


def prefetch_hint_for_state_block(session: "SessionState") -> str | None:
    """Compact prefetch summary for the LLM state block."""
    cache = getattr(session, "turn_prefetch_cache", None) or {}
    lines: list[str] = []

    catalog = cache.get("catalog")
    if isinstance(catalog, dict) and catalog.get("results"):
        top = catalog["results"][0] if catalog["results"] else {}
        title = (top.get("title") or "?")[:48]
        lines.append(f"- Catalog prefetch: {catalog.get('count', len(catalog['results']))} hit(s); top={title!r}")

    order_wrap = cache.get("order")
    if isinstance(order_wrap, dict):
        order = order_wrap.get("order") or {}
        if order.get("found"):
            lines.append(
                f"- Order prefetch #{order.get('order_number')}: "
                f"{order.get('status')}, {order.get('fulfillment_status')}"
            )
            if order.get("items"):
                lines.append(f"  Line items: {'; '.join(order['items'][:4])}")
            if order.get("total"):
                lines.append(f"  Total: {order['total']}")
            if order.get("shipping"):
                lines.append(f"  Shipping: {order['shipping']}")
            if order.get("payment_card_last4"):
                lines.append("  Card last4 available — share only if customer asks.")
            if order.get("email_masked"):
                lines.append(f"  Payment email on file: {order['email_masked']}")
            if order.get("shipping_address"):
                addr = order["shipping_address"]
                city = addr.get("city") or ""
                state = addr.get("state") or ""
                if city:
                    lines.append(f"  Shipped to: {city}, {state}".strip(", "))

    return "\n".join(lines) if lines else None


def payment_groups_hint_for_state_block(session: "SessionState") -> str | None:
    from ..payment.payment_destination_groups import ensure_payment_groups, group_titles_phrase

    groups = ensure_payment_groups(session)
    if not groups:
        return None
    if len(groups) == 1 and not getattr(session, "multi_email_payment_active", False):
        g = groups[0]
        n = len(g.get("variant_ids") or [])
        if n:
            return f"- Payment group: {n} book(s) → one checkout email."
        return None

    lines = [f"- Multi-email payment: {len(groups)} groups."]
    for idx, g in enumerate(groups, start=1):
        titles = group_titles_phrase(g)
        pending = (g.get("pending_email") or g.get("confirmed_email") or "").strip()
        sent = "sent" if g.get("payment_link_sent") else "pending"
        lines.append(f"  Group {idx} ({sent}): {titles}" + (f" → {pending}" if pending else ""))
    return "\n".join(lines)
