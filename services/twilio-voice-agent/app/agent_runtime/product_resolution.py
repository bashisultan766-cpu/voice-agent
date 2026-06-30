"""
Structured product resolution for the product_search workflow (v4.57).

match_product() is the only source of truth for catalog products.
No LLM-invented names, no fallback catalog guesses, no commerce-flow suggestions.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

from .workflow_contracts import (
    PRODUCT_SEARCH_WORKFLOW,
    WorkflowViolationError,
    workflow_guard,
)

logger = logging.getLogger(__name__)

PRODUCT_RESOLUTION_VERSION = "v1.2"
_CATALOG_SOURCE = "shopify_catalog"
_EXACT_TITLE_SCORE = 88
_SIMILAR_TITLE_SCORE = 52
_MAX_SIMILAR = 3
_CONFIDENT_ISBN_MATCH_TYPES = frozenset({
    "barcode",
    "sku",
    "metafield",
    "product_cache",
    "cache",
})


@dataclass
class ProductResolution:
    query: str
    isbn: str = ""
    exact: Optional[dict[str, Any]] = None
    exact_score: float = 0.0
    similar: list[dict[str, Any]] = field(default_factory=list)
    product_kind: str = ""
    tool_results: list[tuple[str, dict]] = field(default_factory=list)


def validate_product_output(product: dict[str, Any] | None) -> dict[str, Any]:
    """
    Block any product not stamped from match_product() / similarity_engine().

    Requires shopify_catalog source, variant_id, and title — blocks hallucinated hits.
    """
    if not product or not isinstance(product, dict):
        raise WorkflowViolationError("NON_CATALOG_PRODUCT_BLOCKED")
    if str(product.get("source") or "") != _CATALOG_SOURCE:
        raise WorkflowViolationError("NON_CATALOG_PRODUCT_BLOCKED")
    variant_id = str(product.get("variant_id") or "").strip()
    title = str(product.get("title") or product.get("name") or "").strip()
    if not variant_id or not title:
        raise WorkflowViolationError("NON_CATALOG_PRODUCT_BLOCKED")
    return product


def _stamp_catalog_product(item: dict[str, Any]) -> dict[str, Any]:
    """Stamp only Shopify tool/index hits — never LLM or staged session state."""
    from .commerce_flow_state import normalize_catalog_hit

    hit = normalize_catalog_hit(item)
    if not hit:
        raise WorkflowViolationError("NON_CATALOG_PRODUCT_BLOCKED")
    variant_id = str(hit.get("variant_id") or "").strip()
    title = str(hit.get("title") or hit.get("name") or "").strip()
    if not variant_id or not title:
        raise WorkflowViolationError("NON_CATALOG_PRODUCT_BLOCKED")
    hit["source"] = _CATALOG_SOURCE
    return validate_product_output(hit)


def _validate_resolution_products(resolution: ProductResolution) -> None:
    if resolution.exact is not None:
        validate_product_output(resolution.exact)
    for hit in resolution.similar:
        validate_product_output(hit)


def _is_confident_isbn_catalog_match(payload: dict[str, Any]) -> bool:
    """Reject uncertain ISBN title-fallback guesses — not an exact catalog match."""
    if not payload.get("found") or not payload.get("product"):
        return False
    if payload.get("needs_confirmation"):
        return False
    match_type = str(payload.get("match_type") or "").lower()
    if match_type == "title_fallback":
        return False
    try:
        confidence = float(payload.get("confidence") or 0.0)
    except (TypeError, ValueError):
        confidence = 0.0
    if match_type in _CONFIDENT_ISBN_MATCH_TYPES:
        return confidence >= 0.9
    return confidence >= 0.95


def _catalog_spoken_title(product: dict[str, Any]) -> str:
    from ..voice.title_speech import spoken_book_title

    validated = validate_product_output(product)
    return spoken_book_title(str(validated.get("title") or "").strip())


def _exact_match_quantity_prompt(product: dict[str, Any]) -> str:
    validated = validate_product_output(product)
    title = _catalog_spoken_title(validated)
    price = str(validated.get("price") or "").strip()
    price_phrase = (
        f"It's {price}."
        if price and price.upper() != "N/A"
        else "It's available."
    )
    return (
        f"Found it — {title}. {price_phrase} "
        f"How many copies would you like?"
    )


def _stage_validated_exact_product(session: "SessionState", product: dict[str, Any]) -> None:
    """Stage only a match_product() exact hit — never LLM or session guesses."""
    from .commerce_flow_state import stage_product_candidate

    top = validate_product_output(product)
    stage_product_candidate(session, top)


def _infer_product_kind(hit: dict[str, Any], query: str = "") -> str:
    blob = " ".join(
        str(hit.get(key) or "")
        for key in ("title", "product_type", "product_kind", "vendor")
    ).lower()
    blob += " " + " ".join(hit.get("tags") or []).lower()
    blob += " " + (query or "").lower()
    if "newspaper" in blob:
        return "newspaper"
    if "magazine" in blob:
        return "magazine"
    if "subscription" in blob:
        return "subscription"
    return "book"


def _dedupe_hits(hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for hit in hits:
        vid = str(hit.get("variant_id") or hit.get("id") or "")
        title = str(hit.get("title") or "").strip().lower()
        key = vid or title
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(hit)
    return out


def _score_hit(query: str, hit: dict[str, Any]) -> float:
    from .isbn_short_circuit import _title_match_score

    return _title_match_score(query, hit)


@workflow_guard(PRODUCT_SEARCH_WORKFLOW, "similarity_engine")
def similarity_engine(
    session: "SessionState | None",
    query: str,
    *,
    product_kind: str = "",
    exclude_variant_ids: set[str] | None = None,
    limit: int = _MAX_SIMILAR,
) -> list[dict[str, Any]]:
    """
    Embedding-style similarity via catalog index + fuzzy title match.

    Uses only indexed Shopify catalog data — never LLM guesses.
    """
    from ..integrations.shopify_catalog_indexer import search_catalog_index

    exclude = exclude_variant_ids or set()
    scored: list[tuple[float, dict[str, Any]]] = []

    for entry in search_catalog_index(query, limit=max(limit * 4, 12)):
        if not isinstance(entry, dict):
            continue
        hit = _stamp_catalog_product({
            "id": entry.get("product_id"),
            "title": entry.get("title"),
            "variant_id": entry.get("variant_id"),
            "price": entry.get("price"),
            "available": entry.get("available_for_sale"),
            "product_type": entry.get("product_type"),
            "tags": entry.get("tags"),
            "vendor": entry.get("vendor"),
            "inventory_quantity": 1 if entry.get("available_for_sale") else 0,
        })
        vid = str(hit.get("variant_id") or "")
        if vid and vid in exclude:
            continue
        kind = _infer_product_kind(hit, query)
        if product_kind and kind != product_kind:
            continue
        score = max(float(entry.get("match_score") or 0) * 10, _score_hit(query, hit))
        if score >= _SIMILAR_TITLE_SCORE:
            scored.append((score, hit))

    scored.sort(key=lambda item: item[0], reverse=True)
    return _dedupe_hits([hit for _, hit in scored])[:limit]


def _similar_from_engine(
    session: "SessionState",
    query: str,
    *,
    product_kind: str = "",
    exact: Optional[dict[str, Any]] = None,
) -> list[dict[str, Any]]:
    exclude = {
        str(exact.get("variant_id") or "")
    } if exact else None
    return similarity_engine(
        session,
        query,
        product_kind=product_kind,
        exclude_variant_ids=exclude,
    )


@workflow_guard(PRODUCT_SEARCH_WORKFLOW, "match_product")
async def match_product(
    session: "SessionState",
    *,
    isbn: str = "",
    title: str = "",
) -> ProductResolution:
    """Structured Shopify lookup by ISBN or title — single catalog pipeline."""
    from ..observability.workflow_events import (
        STEP_PRODUCT_MATCH_ATTEMPTED,
        emit_event,
    )

    input_type = "isbn" if (isbn or "").strip() else "title" if (title or "").strip() else "unknown"
    emit_event(
        {
            "event_type": "workflow_transition",
            "domain": "product_search",
            "step": STEP_PRODUCT_MATCH_ATTEMPTED,
            "input_type": input_type,
            "outcome": "unknown",
            "metadata": {
                "query_len": len((title or isbn or "").strip()),
                "has_isbn": bool((isbn or "").strip()),
            },
        },
        session=session,
    )

    from .llm_tools import CatalogSearchArgs, _catalog_search
    from ..tools import shopify_tools as shopify_st

    query = (title or isbn or "").strip()
    resolution = ProductResolution(query=query, isbn=(isbn or "").strip())

    if isbn:
        raw = await shopify_st.search_product_by_isbn(isbn)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {}
        tool_name = "search_product_by_isbn"
        resolution.tool_results.append(
            (tool_name, payload if isinstance(payload, dict) else {}),
        )
        if isinstance(payload, dict) and _is_confident_isbn_catalog_match(payload):
            product = payload["product"]
            exact = _stamp_catalog_product({
                "id": product.get("product_id"),
                "title": product.get("title"),
                "price": product.get("price"),
                "available": product.get("available"),
                "author": product.get("author"),
                "inventory_quantity": product.get("inventory_quantity"),
                "variants": [{"id": product.get("variant_id"), "price": product.get("price")}],
            })
            resolution.exact = exact
            resolution.exact_score = float(payload.get("confidence") or 1.0) * 100.0
            resolution.product_kind = _infer_product_kind(exact, query)
            resolution.similar = _similar_from_engine(
                session,
                product.get("title") or query,
                product_kind=resolution.product_kind,
                exact=exact,
            )
        else:
            if isinstance(payload, dict) and payload.get("found"):
                logger.info(
                    "isbn_uncertain_match_blocked sid=%s match_type=%s",
                    (getattr(session, "call_sid", "") or "")[:6],
                    str(payload.get("match_type") or "-"),
                )
            resolution.similar = _similar_from_engine(
                session,
                query,
                product_kind=resolution.product_kind,
            )
        _validate_resolution_products(resolution)
        return resolution

    raw = await _catalog_search(CatalogSearchArgs(query=query, limit=5), session)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        payload = {}
    resolution.tool_results.append(
        ("catalog_search", payload if isinstance(payload, dict) else {}),
    )
    results = (payload.get("results") or []) if isinstance(payload, dict) else []
    scored: list[tuple[float, dict[str, Any]]] = []
    for item in results:
        if not isinstance(item, dict):
            continue
        hit = _stamp_catalog_product(item)
        scored.append((_score_hit(query, hit), hit))
    scored.sort(key=lambda item: item[0], reverse=True)

    if scored:
        top_score, top = scored[0]
        resolution.product_kind = _infer_product_kind(top, query)
        if top_score >= _EXACT_TITLE_SCORE:
            resolution.exact = top
            resolution.exact_score = top_score
            resolution.similar = _similar_from_engine(
                session,
                query,
                product_kind=resolution.product_kind,
                exact=resolution.exact,
            )
        else:
            resolution.similar = _similar_from_engine(
                session,
                query,
                product_kind=resolution.product_kind,
            )
    else:
        resolution.similar = _similar_from_engine(
            session,
            query,
            product_kind=resolution.product_kind,
        )

    _validate_resolution_products(resolution)
    return resolution


@workflow_guard(PRODUCT_SEARCH_WORKFLOW, "format_exact_match_reply")
def format_exact_match_reply(resolution: ProductResolution) -> str:
    exact = validate_product_output(resolution.exact)
    base = _exact_match_quantity_prompt(exact)
    similar = _similar_titles(resolution.similar, exclude=exact)
    if similar:
        return f"{base.rstrip('.')}. Similar options include {similar}. How many copies would you like?"
    if "How many" not in base:
        return f"{base.rstrip('.')}. How many copies would you like?"
    return base


@workflow_guard(PRODUCT_SEARCH_WORKFLOW, "format_no_exact_reply")
def format_no_exact_reply(resolution: ProductResolution) -> str:
    if not resolution.similar:
        raise WorkflowViolationError("NON_CATALOG_PRODUCT_BLOCKED")
    for hit in resolution.similar:
        validate_product_output(hit)
    similar = _similar_titles(resolution.similar)
    query = (resolution.query or resolution.isbn or "that item").strip()
    if not similar:
        raise WorkflowViolationError("NON_CATALOG_PRODUCT_BLOCKED")
    return (
        f"We couldn't find the exact product for {query}. "
        f"The closest alternatives are {similar}."
    )


def _similar_titles(
    hits: list[dict[str, Any]],
    *,
    exclude: Optional[dict[str, Any]] = None,
) -> str:
    exclude_vid = str((exclude or {}).get("variant_id") or "")
    names: list[str] = []
    for hit in hits[:_MAX_SIMILAR]:
        validated = validate_product_output(hit)
        if exclude_vid and str(validated.get("variant_id") or "") == exclude_vid:
            continue
        name = _catalog_spoken_title(validated)
        if name and name not in names:
            names.append(name)
    return ", ".join(names)


def has_good_similarity_match(resolution: ProductResolution) -> bool:
    """True when similarity_engine returned catalog alternatives worth offering."""
    return bool(resolution.similar)


async def product_resolution_to_short_circuit(
    session: "SessionState",
    caller_text: str,
    resolution: ProductResolution,
    *,
    isbn: str = "",
):
    """Map structured resolution into the existing product_search short-circuit result."""
    from ..conversation.call_memory import record_product_candidate
    from .isbn_short_circuit import IsbnShortCircuitResult, catalog_hit_is_orderable

    from .not_found_escalation_flow import (
        clear_product_search_fallback,
        stage_product_search_fallback,
        support_handoff_preparation,
    )
    from ..observability.workflow_events import (
        STEP_PRODUCT_EXACT_MATCH_FOUND,
        STEP_PRODUCT_SIMILARITY_FALLBACK_USED,
        emit_event,
    )

    _validate_resolution_products(resolution)
    tool_results = list(resolution.tool_results)
    clear_product_search_fallback(session)

    if resolution.exact:
        top = validate_product_output(resolution.exact)
        emit_event(
            {
                "event_type": "workflow_transition",
                "domain": "product_search",
                "step": STEP_PRODUCT_EXACT_MATCH_FOUND,
                "input_type": "isbn" if isbn else "title",
                "outcome": "success",
                "metadata": {
                    "variant_id": str(top.get("variant_id") or ""),
                    "orderable": bool(catalog_hit_is_orderable(top)),
                },
            },
            session=session,
        )
        record_product_candidate(session, title=top.get("title") or "", found=True)
        validated_similar = [validate_product_output(h) for h in resolution.similar]
        if not catalog_hit_is_orderable(top):
            title = (top.get("title") or "").strip()
            msg = support_handoff_preparation(
                session,
                user_text=caller_text,
                query=resolution.query or isbn,
                reason="product_out_of_stock",
                search_result={
                    "results": [top],
                    "count": 1,
                    "out_of_stock": True,
                    "title": title,
                },
                product_title=title,
                alternatives=validated_similar,
            )
            return IsbnShortCircuitResult(
                force_reply=msg,
                isbn=isbn,
                tool_results=tool_results,
            )
        _stage_validated_exact_product(session, top)
        try:
            from .conversation_state_machine import get_conversation_state

            cs = get_conversation_state(session.call_sid)
            cs.mode = "book_collection"
            cs.expected_next = "quantity"
        except Exception:  # noqa: BLE001
            pass
        return IsbnShortCircuitResult(
            force_reply=format_exact_match_reply(resolution),
            isbn=isbn,
            tool_results=tool_results,
        )

    record_product_candidate(session, title="", found=False)
    has_similar = has_good_similarity_match(resolution)
    if has_similar:
        stage_product_search_fallback(
            session,
            query=resolution.query or isbn,
            isbn=isbn,
            escalation_eligible=True,
        )
        emit_event(
            {
                "event_type": "workflow_transition",
                "domain": "product_search",
                "step": STEP_PRODUCT_SIMILARITY_FALLBACK_USED,
                "input_type": "isbn" if isbn else "title",
                "outcome": "clarify",
                "metadata": {
                    "similar_count": len(resolution.similar),
                },
            },
            session=session,
        )
        return IsbnShortCircuitResult(
            force_reply=format_no_exact_reply(resolution),
            isbn=isbn,
            tool_results=tool_results,
        )

    msg = support_handoff_preparation(
        session,
        user_text=caller_text,
        query=resolution.query or isbn,
        reason="product_not_found",
        search_result={"results": [], "count": 0, "not_found": True},
    )
    return IsbnShortCircuitResult(
        force_reply=msg,
        isbn=isbn,
        tool_results=tool_results,
    )
