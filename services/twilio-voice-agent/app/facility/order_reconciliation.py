"""
Order + facility book reconciliation (v4.33).

Given an order number and facility:
  1. Load order line items from Shopify
  2. Enrich each book with catalog tags/type
  3. Match against facility guidelines from client documents
  4. Search for allowed alternatives for rejected titles
  5. Return empathetic customer_message with website URL
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Optional, TYPE_CHECKING

from .book_content_matcher import BookMatchResult, check_book_against_facility, resolve_facility
from .document_index import excerpt_for_facility
from .guidelines_registry import FacilityGuideline, lookup_facility_guideline

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


@dataclass
class ReconciledBook:
    title: str
    quantity: int = 1
    allowed: bool = True
    reasons: list[str] = field(default_factory=list)
    alternatives: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class OrderFacilityReconciliation:
    order_number: str
    facility_name: str
    facility: FacilityGuideline | None = None
    accepted: list[ReconciledBook] = field(default_factory=list)
    rejected: list[ReconciledBook] = field(default_factory=list)
    customer_message: str = ""
    website_name: str = ""
    website_url: str = ""
    raw_order: dict[str, Any] = field(default_factory=dict)


def _parse_line_items(items: list[str]) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    for item_str in items or []:
        m = re.match(r"^(\d+)x\s+(.+)$", (item_str or "").strip())
        if m:
            out.append((int(m.group(1)), m.group(2).strip()))
        elif item_str.strip():
            out.append((1, item_str.strip()))
    return out


async def _enrich_product(title: str) -> dict[str, Any]:
    from ..tools.shopify_tools import search_products

    raw = await search_products(title, limit=3)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {"title": title}
    results = data.get("results") or []
    if not results:
        return {"title": title}
    top = results[0]
    tags = top.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",")]
    return {
        "title": top.get("title") or title,
        "tags": tags,
        "product_type": top.get("product_type") or top.get("type") or "",
        "author": top.get("author") or "",
        "isbn": top.get("isbn") or "",
        "price": top.get("price") or "",
    }


async def _find_alternatives(
    query: str,
    *,
    facility: FacilityGuideline | None = None,
    limit: int = 5,
) -> list[dict[str, Any]]:
    if not query:
        return []
    from ..tools.shopify_tools import search_products

    raw = await search_products(query, limit=limit)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    alts = []
    for r in (data.get("results") or []):
        title = r.get("title") or ""
        tags = r.get("tags") or []
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",")]
        match = check_book_against_facility(
            title=title,
            facility=facility,
            tags=tags,
            product_type=r.get("product_type") or r.get("type") or "",
            author=r.get("author") or "",
        )
        if match.allowed:
            alts.append({
                "title": title,
                "isbn": r.get("isbn") or "",
                "price": r.get("price") or "",
            })
        if len(alts) >= 3:
            break
    return alts


def _compose_customer_message(
    recon: OrderFacilityReconciliation,
) -> str:
    fac = recon.facility
    parts: list[str] = []

    if not fac:
        parts.append(
            "I don't have detailed guidelines for that facility on file yet. "
            "I can forward this to customer service for a full review."
        )
        return " ".join(parts)

    if not recon.rejected and recon.accepted:
        parts.append(
            f"Good news — based on {fac.name}'s published rules, the books on order "
            f"{recon.order_number} appear to meet their guidelines."
        )
        if fac.website_url:
            parts.append(
                f"You can read the full facility mail rules at {fac.website_name or 'their website'}: "
                f"{fac.website_url}."
            )
        return " ".join(parts)

    if recon.rejected:
        parts.append(
            f"I know it is frustrating when some books reach your loved one and others do not. "
            f"I reviewed order {recon.order_number} against {fac.name}'s published mail rules."
        )
        for book in recon.rejected[:3]:
            reason = book.reasons[0] if book.reasons else "may not meet facility content rules"
            parts.append(f"'{book.title}' was likely returned because {reason}")
        if recon.accepted:
            arrived = ", ".join(b.title for b in recon.accepted[:3])
            parts.append(f"These titles appear acceptable and may have arrived: {arrived}.")

        if recon.rejected and recon.rejected[0].alternatives:
            alt_titles = [a.get("title") for a in recon.rejected[0].alternatives if a.get("title")]
            if alt_titles:
                parts.append(
                    "Similar books that may be allowed include: "
                    + "; ".join(alt_titles[:2])
                    + ". I can add one if you'd like."
                )

        if fac.website_url:
            parts.append(
                f"For the complete list of what {fac.name} allows, visit "
                f"{fac.website_name or 'their official page'}: {fac.website_url}."
            )
        return " ".join(parts)

    parts.append(
        f"I pulled up order {recon.order_number}. "
        "Please tell me which titles did not arrive and I will check them against the facility rules."
    )
    return " ".join(parts)


async def reconcile_order_facility(
    session: "SessionState",
    order_number: str,
    facility_name: str,
    *,
    email: str | None = None,
    phone: str | None = None,
) -> OrderFacilityReconciliation:
    """
    Full reconciliation: Shopify order + facility docs + alternative suggestions.
    """
    from ..tools.shopify_tools import lookup_order

    order_number = (order_number or "").lstrip("#").strip()
    facility_name = (facility_name or getattr(session, "last_facility_name", "") or "").strip()

    raw = await lookup_order(
        order_number=order_number,
        email=email,
        phone=phone or getattr(session, "from_number", None),
        session=session,
    )
    try:
        order = json.loads(raw)
    except json.JSONDecodeError:
        order = {}

    if not facility_name and order.get("facility_hint"):
        facility_name = order["facility_hint"]
    if not facility_name and order.get("found"):
        from .facility_resolver import facility_from_order

        facility_name = facility_from_order(order)

    fac = resolve_facility(facility_name) if facility_name else None
    if fac and not fac.document_excerpt:
        fac.document_excerpt = excerpt_for_facility(fac.name)

    recon = OrderFacilityReconciliation(
        order_number=order.get("order_number") or order_number,
        facility_name=facility_name or (fac.name if fac else ""),
        facility=fac,
        raw_order=order,
        website_name=fac.website_name if fac else "",
        website_url=fac.website_url if fac else "",
    )

    if not order.get("found"):
        recon.customer_message = (
            f"I couldn't find order {order_number}. Please confirm the order number "
            "and the email or phone on the order."
        )
        return recon

    if not fac:
        fac = lookup_facility_guideline(facility_name) if facility_name else None
        recon.facility = fac

    if not fac:
        recon.customer_message = (
            "Which correctional facility was this order shipped to? "
            "Once I have the facility name I can explain which books may have been rejected."
        )
        return recon

    session.last_order_number = recon.order_number
    session.last_facility_name = fac.name

    line_items = _parse_line_items(order.get("items") or [])
    if not line_items:
        recon.customer_message = (
            f"I found order {recon.order_number} but need the book titles to check facility rules. "
            "Which books did not arrive?"
        )
        return recon

    for qty, title in line_items:
        product = await _enrich_product(title)
        match: BookMatchResult = check_book_against_facility(
            title=product.get("title") or title,
            facility=fac,
            tags=product.get("tags"),
            product_type=product.get("product_type", ""),
            author=product.get("author", ""),
        )
        book = ReconciledBook(
            title=product.get("title") or title,
            quantity=qty,
            allowed=match.allowed,
            reasons=match.reasons,
        )
        if not match.allowed:
            book.alternatives = await _find_alternatives(
                match.alternative_search_query,
                facility=fac,
            )
            recon.rejected.append(book)
        else:
            recon.accepted.append(book)

    recon.customer_message = _compose_customer_message(recon)
    logger.info(
        "order_facility_reconciled sid=%s order=%s facility=%r accepted=%d rejected=%d",
        session.call_sid[:6],
        recon.order_number,
        fac.name,
        len(recon.accepted),
        len(recon.rejected),
    )
    return recon


async def reconcile_order_facility_json(
    session: "SessionState",
    order_number: str,
    facility_name: str = "",
    *,
    email: str | None = None,
    phone: str | None = None,
) -> str:
    """JSON payload for LLM tool."""
    recon = await reconcile_order_facility(
        session, order_number, facility_name, email=email, phone=phone,
    )
    return json.dumps({
        "order_number": recon.order_number,
        "facility_name": recon.facility_name,
        "website_name": recon.website_name,
        "website_url": recon.website_url,
        "accepted_books": [
            {"title": b.title, "quantity": b.quantity} for b in recon.accepted
        ],
        "rejected_books": [
            {
                "title": b.title,
                "quantity": b.quantity,
                "reasons": b.reasons,
                "alternatives": b.alternatives,
            }
            for b in recon.rejected
        ],
        "customer_message": recon.customer_message,
        "facility_approved": recon.facility.approved if recon.facility else None,
        "content_notes": recon.facility.content_notes if recon.facility else "",
    })
