"""Normalize worker product facts into ProductCandidate objects (v4.14.7)."""
from __future__ import annotations

import logging
import re
import uuid
from difflib import SequenceMatcher
from typing import Any

from .commerce_session import ProductCandidate

logger = logging.getLogger(__name__)


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _extract_from_worker_result(name: str, data: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not data:
        return rows
    if data.get("not_found"):
        return rows
    if data.get("results") and isinstance(data["results"], list):
        for item in data["results"][:5]:
            if isinstance(item, dict):
                rows.append({**item, "_source_worker": name})
        return rows
    if data.get("title") or data.get("product_title"):
        rows.append({**data, "_source_worker": name})
    return rows


def _parse_tags(raw: Any) -> list[str]:
    if isinstance(raw, list):
        return [str(t).strip() for t in raw if t]
    if isinstance(raw, str):
        return [t.strip() for t in raw.split(",") if t.strip()]
    return []


def _row_to_candidate(
    row: dict[str, Any],
    *,
    query: str,
    rank: float,
    fact_id: str,
    query_entities: dict[str, Any] | None = None,
) -> ProductCandidate:
    query_entities = query_entities or {}
    title = str(row.get("title") or row.get("product_title") or "").strip()
    product_id = str(row.get("product_id") or row.get("id") or "") or None
    variant_id = str(row.get("variant_id") or "") or None
    if not variant_id:
        variants = row.get("variants") or []
        if variants and isinstance(variants[0], dict):
            variant_id = str(variants[0].get("id") or "") or None
    isbn = str(row.get("isbn") or row.get("sku") or "") or None
    if isbn and not re.fullmatch(r"\d{10,13}", isbn.replace("-", "")):
        if len(re.sub(r"\D", "", isbn)) not in (10, 13):
            isbn = None
    price = row.get("price") or row.get("formatted_price")
    price_str = str(price).strip() if price else None
    currency = str(row.get("currency") or "USD")
    available = row.get("available")
    inventory = row.get("inventory_quantity") or row.get("inventory")
    inv_qty: int | None = None
    if inventory is not None:
        try:
            inv_qty = int(inventory)
        except (TypeError, ValueError):
            inv_qty = None
    availability = "available"
    if available is False or (inv_qty is not None and inv_qty <= 0):
        availability = "out_of_stock"
    elif row.get("availability"):
        availability = str(row["availability"])
    author = row.get("author")
    author_str = str(author).strip() if author else None
    source = str(row.get("_source_worker") or row.get("source") or "catalog")
    product_kind = (
        row.get("product_kind")
        or query_entities.get("product_kind")
        or row.get("product_type")
        or None
    )
    if product_kind:
        product_kind = str(product_kind).lower()
    from .catalog_orderability import assess_orderability

    order = assess_orderability({
        **row,
        "variant_id": variant_id,
        "price": price_str,
        "available": available,
        "availability": availability,
    })
    status = str(row.get("status") or order.get("status") or "") or None
    return ProductCandidate(
        candidate_id=str(uuid.uuid4())[:12],
        product_id=product_id,
        variant_id=variant_id,
        title=title,
        author=author_str,
        isbn=isbn,
        price=price_str,
        currency=currency,
        availability=order.get("availability") or availability,
        inventory_quantity=inv_qty,
        source=source,
        confidence=rank,
        raw_fact_ids=[fact_id],
        product_kind=product_kind,
        product_type=str(row.get("product_type") or "") or None,
        vendor=str(row.get("vendor") or "") or None,
        handle=str(row.get("handle") or "") or None,
        tags=_parse_tags(row.get("tags")),
        delivery_frequency=query_entities.get("delivery_frequency"),
        subscription_term=query_entities.get("subscription_term") or query_entities.get("term"),
        inventory_policy=str(row.get("inventory_policy") or "") or None,
        status=status,
        published=row.get("published") if row.get("published") is not None else order.get("published"),
        online_store_visible=row.get("online_store_visible") if row.get("online_store_visible") is not None else order.get("online_store_visible"),
        can_add_to_cart=bool(row.get("can_add_to_cart", order.get("can_add_to_cart", True))),
        unavailable_reason=str(row.get("unavailable_reason") or order.get("unavailable_reason") or "") or None,
        checkout_variant_valid=bool(row.get("checkout_variant_valid", order.get("checkout_variant_valid", bool(variant_id)))),
    )


def _score_candidate(
    candidate: ProductCandidate,
    query: str,
    query_isbn: str | None,
    query_entities: dict[str, Any] | None = None,
) -> float:
    query_entities = query_entities or {}
    score = candidate.confidence
    q = _norm(query)
    title = _norm(candidate.title)
    pub_title = _norm(str(query_entities.get("publication_title") or ""))
    if query_isbn and candidate.isbn and query_isbn.replace("-", "") == candidate.isbn.replace("-", ""):
        return 0.99
    if pub_title and pub_title == title:
        return max(score, 0.95)
    if pub_title and pub_title in title:
        return max(score, 0.90)
    if q and title == q:
        return max(score, 0.92)
    if q and q in title:
        return max(score, 0.85)
    if q and title in q:
        return max(score, 0.80)
    kind = str(query_entities.get("product_kind") or "").lower()
    if kind and candidate.product_kind and kind == candidate.product_kind.lower():
        score = max(score, 0.82)
    freq = str(query_entities.get("delivery_frequency") or "").lower()
    if freq and freq in title:
        score = max(score, 0.78)
    term = str(query_entities.get("subscription_term") or query_entities.get("term") or "").lower()
    if term and term.replace(" ", "") in title.replace(" ", ""):
        score = max(score, 0.76)
    ratio = SequenceMatcher(None, q, title).ratio() if q and title else 0.0
    if ratio >= 0.55:
        return max(score, 0.55 + ratio * 0.3)
    return score


def _dedupe(candidates: list[ProductCandidate]) -> list[ProductCandidate]:
    seen: set[tuple[str, str]] = set()
    out: list[ProductCandidate] = []
    for c in candidates:
        key = (c.product_id or "", c.variant_id or c.title.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def normalize_product_candidates(
    facts: dict[str, Any],
    original_query: str,
    sid: str,
    query_entities: dict[str, Any] | None = None,
) -> list[ProductCandidate]:
    """Normalize worker fact structures into ranked ProductCandidate list."""
    from .business_intent_resolver import extract_isbn_from_text

    query = (original_query or "").strip()
    query_isbn = extract_isbn_from_text(query)
    rows: list[dict[str, Any]] = []
    for worker_name, payload in (facts or {}).items():
        if isinstance(payload, dict):
            rows.extend(_extract_from_worker_result(worker_name, payload))
    candidates: list[ProductCandidate] = []
    for idx, row in enumerate(rows):
        fact_id = f"{row.get('_source_worker', 'fact')}_{idx}"
        base_rank = 0.70
        c = _row_to_candidate(
            row, query=query, rank=base_rank, fact_id=fact_id, query_entities=query_entities,
        )
        if c.title:
            c.confidence = _score_candidate(c, query, query_isbn, query_entities)
            candidates.append(c)
    candidates = _dedupe(candidates)
    candidates.sort(key=lambda x: x.confidence, reverse=True)
    exact_isbn = any(
        query_isbn
        and c.isbn
        and query_isbn.replace("-", "") == c.isbn.replace("-", "")
        for c in candidates
    )
    selected = candidates[0].candidate_id if candidates else None
    logger.info(
        "product_candidates_normalized sid=%s count=%d exact_isbn=%s selected=%s",
        sid[:6] if sid else "?",
        len(candidates),
        exact_isbn,
        (selected or "none")[:8] if selected else "none",
    )
    return candidates
