"""
Canonical OpenAI tool surface for the LLM-first runtime.

Exposes backend capabilities as OpenAI function tools. For each tool:

* a clean JSON schema is published to the model (``tool_specs``),
* inputs are validated with Pydantic before any backend call,
* execution reuses the existing, hardened Shopify / cart / email / escalation
  logic (no business logic is duplicated here),
* results are returned as structured JSON strings,
* secrets, raw payment URLs, full card numbers, and unverified PII never leave
  these functions — verification gating is enforced by the underlying order and
  refund tools.

This module is the ONLY tool registry the live runtime uses. The legacy
worker/composer fan-out is not in the customer path.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional, TYPE_CHECKING

from pydantic import BaseModel, Field, ValidationError

from ..tools import shopify_tools as _st

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Pydantic input models (validation only — schemas published separately).
# ──────────────────────────────────────────────────────────────────────────────
class SearchProductsArgs(BaseModel):
    query: str = Field(..., min_length=1, description="Title, author, ISBN, SKU, or keyword.")
    limit: int = Field(5, ge=1, le=10)


class GetProductDetailsArgs(BaseModel):
    product_id_or_handle: str = Field(..., min_length=1)


class CompareProductsArgs(BaseModel):
    queries: list[str] = Field(..., min_length=2, max_length=4)


class GetCartArgs(BaseModel):
    pass


class AddToCartArgs(BaseModel):
    title: str = Field("", description="Book title to add.")
    isbn: str = Field("", description="ISBN if known.")
    variant_id: str = Field("", description="Shopify variant GID if known.")
    price: str = Field("", description="Price if known.")
    quantity: int = Field(1, ge=1, le=99)


class UpdateCartArgs(BaseModel):
    isbn_or_title: str = Field(..., min_length=1)
    quantity: int = Field(..., ge=1, le=99)


class RemoveFromCartArgs(BaseModel):
    isbn_or_title: str = Field(..., min_length=1)


class CreateCheckoutArgs(BaseModel):
    email: str = Field("", description="Confirmed customer email (optional; session value preferred).")


class SendPaymentLinkArgs(BaseModel):
    email: str = Field("", description="Confirmed customer email.")
    customer_email: str = Field("", description="Alias for email.")
    to_email: str = Field("", description="Alias for email.")

    def resolved_email(self) -> str:
        return (self.email or self.customer_email or self.to_email).strip()


class LookupOrderStatusArgs(BaseModel):
    order_number: str = Field("", description="Order number with or without #.")
    email: str = Field("", description="Email for verification.")
    phone: str = Field("", description="Phone for verification.")


class LookupRefundStatusArgs(BaseModel):
    order_number: str = Field(..., min_length=1)
    email: str = Field("", description="Email for verification.")
    phone: str = Field("", description="Phone for verification.")


class LookupCustomerArgs(BaseModel):
    email: str = Field("", description="Customer email.")
    phone: str = Field("", description="Customer phone.")


class ShippingPolicyArgs(BaseModel):
    topic: str = Field("", description="Optional: address change, media mail, priority mail, cost.")


class RefundPolicyArgs(BaseModel):
    topic: str = Field("", description="Optional refund sub-topic.")


class FacilityPolicyArgs(BaseModel):
    facility_name: str = Field(..., min_length=1)
    order_number: str = Field("", description="Optional order number to cross-reference.")
    state: str = Field("", description="Facility state if known.")


class SearchFacilityPolicyArgs(BaseModel):
    facility_name: str = Field(..., min_length=1)
    state: str = Field("", description="US state code if known.")


class CheckFacilityContentAllowedArgs(BaseModel):
    facility_name: str = Field(..., min_length=1)
    content_type: str = Field(
        ...,
        description="book | magazine | newspaper | subscription",
    )
    state: str = Field("", description="US state code if known.")


class ExplainFacilityRestrictionArgs(BaseModel):
    facility_name: str = Field("", description="Correctional facility name.")
    content_type: str = Field("", description="book | magazine | newspaper | subscription")
    product_title: str = Field("", description="Book or product title if relevant.")
    state: str = Field("", description="US state code if known.")
    order_number: str = Field("", description="Order number for delivery questions.")
    email: str = Field("", description="Email for order verification.")
    phone: str = Field("", description="Phone for order verification.")


class FetchFacilityPolicyAnalysisArgs(BaseModel):
    facility_name: str = Field(..., min_length=1)
    state: str = Field("", description="US state code if known.")


class AnswerFacilityPolicyQuestionArgs(BaseModel):
    facility_name: str = Field(..., min_length=1)
    question: str = Field(..., min_length=1)
    content_type: str = Field("", description="book | magazine | newspaper | subscription")
    product_title: str = Field("", description="Product title if relevant.")
    state: str = Field("", description="US state code if known.")


class ExplainFacilityDeliveryRejectionArgs(BaseModel):
    facility_name: str = Field("", description="Correctional facility name.")
    product_title: str = Field("", description="Product title if relevant.")
    content_type: str = Field("", description="book | magazine | newspaper | subscription")
    state: str = Field("", description="US state code if known.")
    order_number: str = Field("", description="Order number for delivery questions.")
    email: str = Field("", description="Email for order verification.")
    phone: str = Field("", description="Phone for order verification.")


class ClassifyProductContentForFacilityArgs(BaseModel):
    product_title: str = Field("", description="Product title.")
    product_description: str = Field("", description="Product description if available.")
    product_type: str = Field("", description="Shopify product type.")
    product_tags: list[str] = Field(default_factory=list)


class FaqLookupArgs(BaseModel):
    question: str = Field(..., min_length=1)


class EscalateArgs(BaseModel):
    reason: str = Field(..., min_length=1)
    summary: str = Field("", description="Short summary for the human agent.")


class CreateProductNotFoundEscalationArgs(BaseModel):
    session_id: str = Field("", description="Voice session id.")
    call_sid: str = Field("", description="Twilio call SID.")
    customer_phone: str = Field("", description="Caller phone.")
    customer_name: str = Field("", description="Caller name if known.")
    customer_email: str = Field("", description="Confirmed customer email.")
    requested_type: str = Field(
        "unknown",
        description="isbn|title|author|newspaper|magazine|product|unknown",
    )
    requested_value: str = Field(..., min_length=1, description="ISBN, title, or product requested.")
    quantity: Optional[int] = Field(None, ge=1, le=99)
    facility_name: str = Field("", description="Facility name if relevant.")
    conversation_summary: str = Field("", description="Short call context.")
    last_search_results: dict[str, Any] = Field(default_factory=dict)
    reason: str = Field("product_not_found", description="Escalation reason code.")


class NormalizeVoiceIntentArgs(BaseModel):
    text: str = Field(..., min_length=1, description="Caller utterance to normalize.")
    context: str = Field("", description="Optional prior context from the call.")


class GetOrderArgs(BaseModel):
    order_number: str = Field("", description="Order number with or without #.")
    email: str = Field("", description="Email for verification.")
    phone: str = Field("", description="Phone for verification.")


class CatalogSearchArgs(BaseModel):
    query: str = Field(..., min_length=1, description="Title, author, ISBN, SKU, or keyword.")
    limit: int = Field(5, ge=1, le=10)


class CalculatePricingArgs(BaseModel):
    order_number: str = Field("", description="Order number.")
    email: str = Field("", description="Email for verification.")
    phone: str = Field("", description="Phone for verification.")


class CheckFacilityApprovalArgs(BaseModel):
    facility_name: str = Field(..., min_length=1)
    city: str = Field("", description="Facility city if known.")
    state: str = Field("", description="Facility state if known.")
    order_number: str = Field("", description="Optional order number.")


class CheckOrderFacilityRestrictionsArgs(BaseModel):
    order_number: str = Field("", description="Order number.")
    facility_name: str = Field("", description="Facility name.")
    book_title: str = Field("", description="Specific book title if asking about one book.")


class ReconcileOrderFacilityBooksArgs(BaseModel):
    order_number: str = Field(..., min_length=1, description="Shopify order number.")
    facility_name: str = Field("", description="Correctional facility name.")
    email: str = Field("", description="Email on order for verification.")
    phone: str = Field("", description="Phone on order for verification.")


class AddressUpdateInstructionsArgs(BaseModel):
    order_number: str = Field("", description="Order number if known.")


class CancelOrderRequestArgs(BaseModel):
    order_number: str = Field(..., min_length=1)
    email: str = Field("", description="Email for verification.")


class SendFacilityPaymentLinkArgs(BaseModel):
    email: str = Field(..., min_length=3, description="Confirmed customer email.")
    order_number: str = Field("", description="Order number if known.")


class GetCallerInfoArgs(BaseModel):
    pass


class SaveCallerNameArgs(BaseModel):
    name: str = Field(..., min_length=1, description="Caller's name as stated.")


# ──────────────────────────────────────────────────────────────────────────────
# Tool implementations (thin wrappers over existing hardened logic).
# ──────────────────────────────────────────────────────────────────────────────
def _err(message: str) -> str:
    return json.dumps({"error": message})


def _rerank_by_fuzzy(query: str, results: list[dict]) -> list[dict]:
    """Re-rank product results by fuzzy similarity to the query (best-effort)."""
    if not results:
        return results
    try:
        from rapidfuzz import fuzz

        def score(r: dict) -> float:
            title = str(r.get("title", ""))
            author = str(r.get("author", ""))
            return max(
                fuzz.WRatio(query, title),
                fuzz.WRatio(query, f"{title} {author}".strip()),
            )

        return sorted(results, key=score, reverse=True)
    except Exception:  # noqa: BLE001 — ranking is optional
        return results


async def _search_products(args: SearchProductsArgs, session) -> str:
    raw = await _st.search_products(query=args.query, limit=args.limit)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if isinstance(payload, dict) and payload.get("results"):
        payload["results"] = _rerank_by_fuzzy(args.query, payload["results"])
        from .commerce_flow_state import maybe_stage_from_search_payload

        maybe_stage_from_search_payload(session, payload)
    return json.dumps(payload)


async def _get_product_details(args: GetProductDetailsArgs, session) -> str:
    raw = await _st.get_product_details(product_id_or_handle=args.product_id_or_handle)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if isinstance(payload, dict) and payload.get("variant_id") and session is not None:
        from .commerce_flow_state import stage_product_candidate

        stage_product_candidate(session, payload)
    return raw if isinstance(raw, str) else json.dumps(payload)


async def _compare_products(args: CompareProductsArgs, session) -> str:
    items = []
    for q in args.queries:
        raw = await _st.search_products(query=q, limit=1)
        try:
            payload = json.loads(raw)
            results = payload.get("results") or []
            top = results[0] if results else None
        except json.JSONDecodeError:
            top = None
        if top:
            items.append({
                "query": q,
                "title": top.get("title"),
                "price": top.get("price"),
                "available": top.get("available"),
                "author": top.get("author", ""),
            })
        else:
            items.append({"query": q, "found": False})
    return json.dumps({"comparison": items, "count": len(items)})


def _ledger_view(session) -> dict:
    from ..cart.session import get_ledger

    ledger = get_ledger(session)
    return {
        "confirmed_count": ledger.confirmed_count(),
        "confirmed_titles": ledger.confirmed_titles(),
        "candidate_titles": [
            i.title for i in ledger.items if i.confirmation_status == "candidate"
        ],
        "summary": ledger.cart_summary_text(),
    }


async def _get_cart(args: GetCartArgs, session) -> str:
    if session is None:
        return json.dumps({"confirmed_count": 0, "summary": "No active cart."})
    return json.dumps(_ledger_view(session))


async def _add_to_cart(args: AddToCartArgs, session) -> str:
    if session is None:
        return _err("No active session.")
    if not (args.title or args.isbn or args.variant_id):
        return _err("Need a title, ISBN, or product to add to the cart.")
    from ..cart.session import add_product_candidate, confirm_last_candidate

    add_product_candidate(
        session,
        title=args.title or args.isbn or "Selected book",
        isbn=args.isbn,
        variant_id=args.variant_id,
        price=args.price or None,
        quantity=max(1, int(args.quantity or 1)),
    )
    # An explicit add-to-cart is an explicit selection; confirm it.
    confirm_last_candidate(session)
    from ..payment.payment_destination_groups import refresh_payment_groups_from_cart

    refresh_payment_groups_from_cart(session)
    view = _ledger_view(session)
    if view.get("confirmed_count", 0) > 0:
        pfs = getattr(session, "payment_flow_status", "idle") or "idle"
        if pfs in ("idle", ""):
            session.payment_flow_status = "awaiting_email"
        session.payment_cart_confirmed = True
        from .commerce_flow_state import on_book_added_to_cart

        on_book_added_to_cart(session, args.title or args.isbn or "Selected book")
    payload = {"success": True, "cart": view}
    if getattr(session, "commerce_flow_status", "") == "awaiting_another_book":
        from .commerce_flow_state import another_book_after_add_prompt

        titles = view.get("confirmed_titles") or []
        if titles:
            payload["customer_message"] = another_book_after_add_prompt()
    return json.dumps(payload)


async def _update_cart(args: UpdateCartArgs, session) -> str:
    if session is None:
        return _err("No active session.")
    from ..cart.session import get_ledger, sync_ledger_to_session

    ledger = get_ledger(session)
    ok = ledger.update_quantity(args.isbn_or_title, args.quantity)
    sync_ledger_to_session(session, ledger)
    if not ok:
        return _err(f"'{args.isbn_or_title}' was not found in the cart.")
    return json.dumps({"success": True, "cart": _ledger_view(session)})


async def _remove_from_cart(args: RemoveFromCartArgs, session) -> str:
    if session is None:
        return _err("No active session.")
    from ..cart.session import get_ledger, sync_ledger_to_session

    ledger = get_ledger(session)
    target = args.isbn_or_title.lower().strip()
    removed = False
    for item in ledger.items:
        if item.isbn == args.isbn_or_title or item.title.lower() == target:
            item.confirmation_status = "rejected"
            removed = True
    sync_ledger_to_session(session, ledger)
    if not removed:
        return _err(f"'{args.isbn_or_title}' was not found in the cart.")
    return json.dumps({"success": True, "cart": _ledger_view(session)})


async def _create_checkout(args: CreateCheckoutArgs, session) -> str:
    if session is None:
        return _err("No active session.")
    from ..cart.session import get_ledger

    items = get_ledger(session).to_checkout_items()
    if not items:
        return _err("There are no confirmed books in the cart yet.")
    return await _st.create_checkout_link(
        items=items,
        email=args.email or None,
        session=session,
    )


async def _send_payment_link(args: SendPaymentLinkArgs, session) -> str:
    if session is None:
        return _err("No active session.")
    from .payment_flow_state import gate_send_payment_link
    from ..payment.payment_link_service import send_confirmed_payment_link

    # Never trust LLM email args — gate uses session.confirmed_email only.
    gate = gate_send_payment_link(session, "")
    if not gate.allowed:
        return gate.tool_json

    result = await send_confirmed_payment_link(session)
    return json.dumps(result)


async def _lookup_order_status(args: LookupOrderStatusArgs, session) -> str:
    if not (args.order_number or args.email or args.phone):
        return _err("Provide an order number, email, or phone to look up an order.")
    return await _st.lookup_order(
        order_number=args.order_number or None,
        email=args.email or None,
        phone=args.phone or None,
        session=session,
    )


async def _lookup_refund_status(args: LookupRefundStatusArgs, session) -> str:
    return await _st.get_refund_status(
        order_number=args.order_number,
        email=args.email or None,
        phone=args.phone or None,
        session=session,
    )


async def _lookup_customer(args: LookupCustomerArgs, session) -> str:
    # Friendly recognition only (no PII). Phone-based recognition is supported by
    # the existing identity resolver; email lookup falls back to phone match.
    phone = args.phone or (getattr(session, "from_number", "") if session else "")
    result = await _st.SearchCustomerByPhone(phone=phone or None, session=session)
    return result


async def _shipping_policy(args: ShippingPolicyArgs, session) -> str:
    from ..config import get_settings
    from .knowledge_base import retrieve_knowledge_snippets

    settings = get_settings()
    snippets = retrieve_knowledge_snippets(
        args.topic or "shipping subtotal media mail priority", intent="shipping_question"
    )
    return json.dumps({
        "default_method": settings.SHIPPING_DEFAULT_METHOD,
        "alt_method": settings.SHIPPING_ALT_METHOD,
        "note": "Subtotal is before shipping. Shipping depends on method and destination.",
        "policy_snippets": snippets,
    })


async def _refund_policy(args: RefundPolicyArgs, session) -> str:
    from .knowledge_base import retrieve_knowledge_snippets

    snippets = retrieve_knowledge_snippets(
        args.topic or "refund", intent="refund_policy"
    )
    return json.dumps({"policy_snippets": snippets})


async def _facility_policy(args: FacilityPolicyArgs, session) -> str:
    """Backward-compatible alias — searches normalized facility policy records."""
    return await _search_facility_policy(
        SearchFacilityPolicyArgs(
            facility_name=args.facility_name,
            state=args.state or "",
        ),
        session,
    )


async def _search_facility_policy(args: SearchFacilityPolicyArgs, session) -> str:
    from ..facility.policy_service import search_facility_policy

    result = search_facility_policy(args.facility_name, state=args.state or None)
    if session and result.get("facility_name"):
        session.last_facility_name = str(result["facility_name"])
    return json.dumps(result)


async def _check_facility_content_allowed(
    args: CheckFacilityContentAllowedArgs, session,
) -> str:
    from ..facility.policy_service import check_content_allowed

    result = check_content_allowed(
        args.facility_name,
        args.content_type,
        state=args.state or None,
    )
    if session and result.get("facility_name"):
        session.last_facility_name = str(result["facility_name"])
    return json.dumps(result)


async def _explain_facility_restriction(
    args: ExplainFacilityRestrictionArgs, session,
) -> str:
    from ..facility.policy_service import explain_facility_restriction

    order_items: list[str] = []
    order_number = (args.order_number or "").strip()
    facility_name = (args.facility_name or "").strip()

    if order_number and session is not None:
        raw = await _st.lookup_order(
            order_number=order_number,
            email=args.email or None,
            phone=args.phone or None,
            session=session,
        )
        try:
            order_data = json.loads(raw)
        except json.JSONDecodeError:
            order_data = {}
        if order_data.get("verification_required"):
            return json.dumps({
                "found": False,
                "escalation_required": False,
                "verification_required": True,
                "message": order_data.get("message")
                or "I need to verify your email or phone on the order first.",
            })
        if not order_data.get("found"):
            return json.dumps({
                "found": False,
                "escalation_required": True,
                "message": order_data.get("message") or "I could not find that order.",
            })
        order_items = list(order_data.get("items") or order_data.get("book_titles") or [])
        if not facility_name:
            facility_name = str(order_data.get("facility_hint") or "").strip()

    if not facility_name and session is not None:
        facility_name = (getattr(session, "last_facility_name", "") or "").strip()

    result = explain_facility_restriction(
        facility_name,
        args.content_type or "",
        product_title=args.product_title or None,
        state=args.state or None,
        order_number=order_number or None,
        order_items=order_items or None,
    )
    if session and result.get("facility_name"):
        session.last_facility_name = str(result["facility_name"])
    return json.dumps(result)


async def _fetch_facility_policy_analysis(
    args: FetchFacilityPolicyAnalysisArgs, session,
) -> str:
    from ..facility.policy_service import get_facility_policy_analysis

    result = get_facility_policy_analysis(args.facility_name, state=args.state or None)
    if session and result.get("facility_name"):
        session.last_facility_name = str(result["facility_name"])
    return json.dumps(result)


async def _answer_facility_policy_question(
    args: AnswerFacilityPolicyQuestionArgs, session,
) -> str:
    from ..facility.policy_service import answer_facility_question

    result = answer_facility_question(
        args.facility_name,
        args.question,
        content_type=args.content_type or None,
        product_title=args.product_title or None,
        state=args.state or None,
    )
    if session and result.get("facility_name"):
        session.last_facility_name = str(result["facility_name"])
    return json.dumps(result)


async def _explain_facility_delivery_rejection(
    args: ExplainFacilityDeliveryRejectionArgs, session,
) -> str:
    from ..facility.policy_service import explain_delivery_rejection

    order_items: list[str] = []
    order_number = (args.order_number or "").strip()
    facility_name = (args.facility_name or "").strip()

    if order_number and session is not None:
        raw = await _st.lookup_order(
            order_number=order_number,
            email=args.email or None,
            phone=args.phone or None,
            session=session,
        )
        try:
            order_data = json.loads(raw)
        except json.JSONDecodeError:
            order_data = {}
        if order_data.get("verification_required"):
            return json.dumps({
                "found": False,
                "escalation_required": False,
                "verification_required": True,
                "message": order_data.get("message")
                or "I need to verify your email or phone on the order first.",
            })
        if not order_data.get("found"):
            return json.dumps({
                "found": False,
                "escalation_required": True,
                "message": order_data.get("message") or "I could not find that order.",
            })
        order_items = list(order_data.get("items") or order_data.get("book_titles") or [])
        if not facility_name:
            facility_name = str(order_data.get("facility_hint") or "").strip()

    if not facility_name and session is not None:
        facility_name = (getattr(session, "last_facility_name", "") or "").strip()

    result = explain_delivery_rejection(
        facility_name,
        product_title=args.product_title or None,
        content_type=args.content_type or None,
        order_context={"order_number": order_number, "order_items": order_items},
        state=args.state or None,
    )
    if session and result.get("facility_name"):
        session.last_facility_name = str(result["facility_name"])
    return json.dumps(result)


async def _classify_product_content_for_facility(
    args: ClassifyProductContentForFacilityArgs, session,
) -> str:
    from ..facility.product_content_classifier import classify_product_content

    result = classify_product_content(
        product_title=args.product_title,
        product_description=args.product_description,
        product_tags=args.product_tags,
        product_type=args.product_type,
    )
    return json.dumps(result.to_dict())


async def _faq_lookup(args: FaqLookupArgs, session) -> str:
    from .knowledge_base import retrieve_knowledge_snippets

    snippets = retrieve_knowledge_snippets(args.question)
    return json.dumps({"answers": snippets, "found": bool(snippets)})


async def _escalate(args: EscalateArgs, session) -> str:
    return await _st.escalate_to_human(
        reason=args.reason,
        caller_phone=getattr(session, "from_number", "") if session else "",
        summary=args.summary,
        session=session,
    )


async def _normalize_voice_intent(args: NormalizeVoiceIntentArgs, session) -> str:
    return await _st.NormalizeVoiceIntent(
        text=args.text,
        context=args.context,
        session=session,
    )


async def _get_order(args: GetOrderArgs, session) -> str:
    order_num = (args.order_number or "").lstrip("#").strip()
    cache = getattr(session, "turn_prefetch_cache", None) or {} if session else {}
    order_wrap = cache.get("order")
    if isinstance(order_wrap, dict) and order_num:
        cached_num = str(
            order_wrap.get("order_number")
            or (order_wrap.get("order") or {}).get("order_number")
            or ""
        ).lstrip("#")
        if cached_num and cached_num == order_num:
            order = order_wrap.get("order") or {}
            if order.get("found"):
                logger.info(
                    "get_order_prefetch_hit sid=%s order=%s",
                    (getattr(session, "call_sid", "") or "")[:6],
                    order_num,
                )
                if session is not None:
                    session.order_context = (
                        order.get("suggested_response")
                        or order_wrap.get("suggested_response")
                        or ""
                    )
                return json.dumps(order)

    raw = await _st.GetOrder(
        order_number=args.order_number or None,
        email=args.email or None,
        phone=args.phone or None,
        session=session,
    )
    if session is not None:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return raw
        if isinstance(payload, dict) and payload.get("found"):
            parts = [
                f"Order {payload.get('order_number')}: "
                f"{payload.get('status')}, {payload.get('fulfillment_status')}",
            ]
            items = payload.get("items") or []
            if items:
                parts.append("Items: " + "; ".join(items))
            if payload.get("total"):
                parts.append(f"Total: {payload['total']}")
            elif payload.get("subtotal"):
                parts.append(f"Subtotal: {payload['subtotal']}")
            session.order_context = " ".join(parts)
    return raw


async def _catalog_search(args: CatalogSearchArgs, session) -> str:
    from .isbn_short_circuit import normalize_catalog_search_query

    query, resolved_isbn = normalize_catalog_search_query(args.query, session)
    if resolved_isbn and query != (args.query or "").strip():
        sid = (getattr(session, "call_sid", "") or "")[:6] if session else ""
        logger.info(
            "catalog_search_query_normalized sid=%s raw=%r normalized=%s",
            sid,
            (args.query or "")[:40],
            resolved_isbn,
        )

    cache = getattr(session, "turn_prefetch_cache", None) or {} if session else {}
    cached = cache.get("catalog")
    if isinstance(cached, dict) and cached.get("results"):
        cache_q = (resolved_isbn or query or "").strip()
        if cache_q and len(cache_q) >= 10:
            logger.info(
                "catalog_search_prefetch_hit sid=%s query=%s",
                (getattr(session, "call_sid", "") or "")[:6],
                cache_q[:13],
            )
            from .commerce_flow_state import maybe_stage_from_search_payload

            maybe_stage_from_search_payload(session, cached)
            return json.dumps(cached)

    raw = await _st.SureShotCatalogSearch(query=query, limit=args.limit)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if isinstance(payload, dict) and payload.get("results"):
        payload["results"] = _rerank_by_fuzzy(args.query, payload["results"])
        from .commerce_flow_state import maybe_stage_from_search_payload

        maybe_stage_from_search_payload(session, payload)
    return json.dumps(payload)


async def _calculate_pricing(args: CalculatePricingArgs, session) -> str:
    return await _st.CalculatePricing(
        order_number=args.order_number or None,
        email=args.email or None,
        phone=args.phone or None,
        session=session,
    )


async def _check_facility_approval(args: CheckFacilityApprovalArgs, session) -> str:
    facility = args.facility_name
    if args.city:
        facility = f"{facility}, {args.city}"
    if args.state:
        facility = f"{facility}, {args.state}"
    return await _st.CheckFacilityApproval(
        facility_name=facility,
        order_number=args.order_number or None,
        session=session,
    )


async def _check_order_facility_restrictions(
    args: CheckOrderFacilityRestrictionsArgs, session,
) -> str:
    if args.order_number and session is not None:
        return await _reconcile_order_facility_books(
            ReconcileOrderFacilityBooksArgs(
                order_number=args.order_number,
                facility_name=args.facility_name or "",
            ),
            session,
        )
    return await _st.CheckOrderFacilityRestrictions(
        order_number=args.order_number or None,
        facility_name=args.facility_name or None,
        session=session,
    )


async def _reconcile_order_facility_books(
    args: ReconcileOrderFacilityBooksArgs, session,
) -> str:
    """Full order + facility doc reconciliation with alternative book suggestions."""
    if session is None:
        return _err("No active session.")
    from ..facility.order_reconciliation import reconcile_order_facility_json

    return await reconcile_order_facility_json(
        session,
        args.order_number,
        args.facility_name,
        email=args.email or None,
        phone=args.phone or None,
    )


async def _address_update_instructions(args: AddressUpdateInstructionsArgs, session) -> str:
    return await _st.AddressUpdateInstructions(
        order_number=args.order_number or None,
        session=session,
    )


async def _cancel_order_request(args: CancelOrderRequestArgs, session) -> str:
    return await _st.CancelOrderRequest(
        order_number=args.order_number,
        email=args.email or None,
        session=session,
    )


async def _send_facility_payment_link(args: SendFacilityPaymentLinkArgs, session) -> str:
    return await _st.SendFacilityPaymentLink(
        email=args.email,
        order_number=args.order_number or None,
        session=session,
    )


async def _get_caller_info(args: GetCallerInfoArgs, session) -> str:
    return await _st.GetCallerInfo(session=session)


async def _save_caller_name(args: SaveCallerNameArgs, session) -> str:
    return await _st.SaveCallerName(name=args.name, session=session)


async def _escalate_to_customer_service(args: EscalateArgs, session) -> str:
    return await _st.EscalateToCustomerService(
        reason=args.reason,
        summary=args.summary,
        session=session,
    )


async def _create_product_not_found_escalation(
    args: CreateProductNotFoundEscalationArgs, session,
) -> str:
    from ..escalation.models import ProductNotFoundEscalationPayload
    from ..escalation.product_not_found_escalation import create_product_not_found_escalation

    payload = ProductNotFoundEscalationPayload(
        session_id=args.session_id,
        call_sid=args.call_sid,
        customer_phone=args.customer_phone,
        customer_name=args.customer_name,
        customer_email=args.customer_email,
        requested_type=args.requested_type,  # type: ignore[arg-type]
        requested_value=args.requested_value,
        quantity=args.quantity,
        facility_name=args.facility_name,
        conversation_summary=args.conversation_summary,
        last_search_results=dict(args.last_search_results or {}),
        reason=args.reason or "product_not_found",
    )
    return await create_product_not_found_escalation(payload, session=session)


# ──────────────────────────────────────────────────────────────────────────────
# Registry: name -> (Pydantic model, impl, description, json schema)
# ──────────────────────────────────────────────────────────────────────────────
class _Tool:
    __slots__ = ("name", "model", "impl", "description", "schema")

    def __init__(self, name, model, impl, description, schema):
        self.name = name
        self.model = model
        self.impl = impl
        self.description = description
        self.schema = schema


def _obj(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required}


_S = {"type": "string"}
_I = {"type": "integer"}


_TOOLS: dict[str, _Tool] = {}

# Internal-only tools: callable via dispatch (e.g. send_payment_link) but never
# exposed to the LLM — prevents create_checkout on the same turn as email capture.
_INTERNAL_ONLY_TOOLS = frozenset({"create_checkout"})


def _register(name, model, impl, description, schema):
    _TOOLS[name] = _Tool(name, model, impl, description, schema)


_register(
    "search_products", SearchProductsArgs, _search_products,
    "Search the SureShot Books catalog by title, author, ISBN, SKU, or keyword. "
    "Authoritative source for availability, price, and stock. Call before any "
    "product answer.",
    _obj({"query": {**_S, "description": "Title, author, ISBN, SKU, or keyword."},
          "limit": {**_I, "description": "Max results 1-10.", "default": 5}}, ["query"]),
)
_register(
    "get_product_details", GetProductDetailsArgs, _get_product_details,
    "Fetch full details (description, price, variants, availability) for one "
    "product by Shopify GID or URL handle. Use for 'what is this book about?'.",
    _obj({"product_id_or_handle": {**_S, "description": "Shopify product GID or handle."}},
         ["product_id_or_handle"]),
)
_register(
    "compare_products", CompareProductsArgs, _compare_products,
    "Compare two to four books side by side (price, availability). Each query is "
    "a title/author/ISBN.",
    _obj({"queries": {"type": "array", "items": _S,
                       "description": "2-4 book queries to compare."}}, ["queries"]),
)
_register(
    "get_cart", GetCartArgs, _get_cart,
    "Return the caller's current cart: confirmed books and pending candidates.",
    _obj({}, []),
)
_register(
    "add_to_cart", AddToCartArgs, _add_to_cart,
    "Add a confirmed book to the caller's cart. Provide a title and/or ISBN and "
    "variant_id (from a prior search) and quantity.",
    _obj({"title": _S, "isbn": _S, "variant_id": _S, "price": _S,
          "quantity": {**_I, "default": 1}}, []),
)
_register(
    "update_cart", UpdateCartArgs, _update_cart,
    "Change the quantity of a book already in the cart, identified by ISBN or title.",
    _obj({"isbn_or_title": _S, "quantity": _I}, ["isbn_or_title", "quantity"]),
)
_register(
    "remove_from_cart", RemoveFromCartArgs, _remove_from_cart,
    "Remove a book from the cart, identified by ISBN or title.",
    _obj({"isbn_or_title": _S}, ["isbn_or_title"]),
)
_register(
    "create_checkout", CreateCheckoutArgs, _create_checkout,
    "INTERNAL: create Shopify checkout for send_payment_link. Not for LLM use.",
    _obj({"email": {**_S, "description": "Confirmed email (optional)."}}, []),
)
_register(
    "send_payment_link", SendPaymentLinkArgs, _send_payment_link,
    "Email the secure payment link for the confirmed cart. Only call AFTER the "
    "customer has confirmed the normalized email (yes/correct). Never read the link aloud.",
    _obj({
        "email": {**_S, "description": "Confirmed customer email (optional if session confirmed)."},
        "customer_email": _S,
        "to_email": _S,
    }, []),
)
_register(
    "lookup_order_status", LookupOrderStatusArgs, _lookup_order_status,
    "Look up order status, fulfillment, tracking, and shipping. Full details "
    "require order number plus a matching email or phone (verification).",
    _obj({"order_number": _S, "email": _S, "phone": _S}, []),
)
_register(
    "lookup_refund_status", LookupRefundStatusArgs, _lookup_refund_status,
    "Look up refund amount, date, and status for an order. Requires order number "
    "plus a matching email or phone for verification.",
    _obj({"order_number": _S, "email": _S, "phone": _S}, ["order_number"]),
)
_register(
    "lookup_customer_by_email_or_phone", LookupCustomerArgs, _lookup_customer,
    "Find a returning customer record by email or phone for friendly recognition "
    "only. Does not return private data and is not identity verification.",
    _obj({"email": _S, "phone": _S}, []),
)
_register(
    "shipping_policy_lookup", ShippingPolicyArgs, _shipping_policy,
    "Get SureShot Books shipping policy: methods, subtotal-vs-shipping, address "
    "change guidance.",
    _obj({"topic": _S}, []),
)
_register(
    "refund_policy_lookup", RefundPolicyArgs, _refund_policy,
    "Get SureShot Books refund policy details (general, not a specific order).",
    _obj({"topic": _S}, []),
)
_register(
    "facility_policy_lookup", FacilityPolicyArgs, _facility_policy,
    "Search facility policy records for books, magazines, newspapers, and restrictions. "
    "Never guess facility rules.",
    _obj({"facility_name": _S, "state": _S, "order_number": _S}, ["facility_name"]),
)
_register(
    "search_facility_policy", SearchFacilityPolicyArgs, _search_facility_policy,
    "Search normalized facility CSV policy data by facility name and optional state.",
    _obj({"facility_name": _S, "state": _S}, ["facility_name"]),
)
_register(
    "check_facility_content_allowed",
    CheckFacilityContentAllowedArgs,
    _check_facility_content_allowed,
    "Check whether books, magazines, newspapers, or subscriptions are allowed at a facility.",
    _obj({"facility_name": _S, "content_type": _S, "state": _S}, ["facility_name", "content_type"]),
)
_register(
    "explain_facility_restriction",
    ExplainFacilityRestrictionArgs,
    _explain_facility_restriction,
    "Explain why an item may not be delivered to a facility using policy data only. "
    "Optionally cross-reference a verified order.",
    _obj({
        "facility_name": _S,
        "content_type": _S,
        "product_title": _S,
        "state": _S,
        "order_number": _S,
        "email": _S,
        "phone": _S,
    }, []),
)
_register(
    "fetch_facility_policy_analysis",
    FetchFacilityPolicyAnalysisArgs,
    _fetch_facility_policy_analysis,
    "Load cached offline facility policy analysis (never fetches URLs live).",
    _obj({"facility_name": _S, "state": _S}, ["facility_name"]),
)
_register(
    "answer_facility_policy_question",
    AnswerFacilityPolicyQuestionArgs,
    _answer_facility_policy_question,
    "Answer a facility mail policy question from cached analysis and CSV data only.",
    _obj({
        "facility_name": _S,
        "question": _S,
        "content_type": _S,
        "product_title": _S,
        "state": _S,
    }, ["facility_name", "question"]),
)
_register(
    "explain_facility_delivery_rejection",
    ExplainFacilityDeliveryRejectionArgs,
    _explain_facility_delivery_rejection,
    "Explain why a facility may have rejected or returned an order item using cached policy.",
    _obj({
        "facility_name": _S,
        "product_title": _S,
        "content_type": _S,
        "state": _S,
        "order_number": _S,
        "email": _S,
        "phone": _S,
    }, []),
)
_register(
    "classify_product_content_for_facility",
    ClassifyProductContentForFacilityArgs,
    _classify_product_content_for_facility,
    "Classify product content type and risk flags for facility policy matching.",
    _obj({
        "product_title": _S,
        "product_description": _S,
        "product_type": _S,
        "product_tags": {"type": "array", "items": _S},
    }, []),
)
_register(
    "faq_lookup", FaqLookupArgs, _faq_lookup,
    "Look up an answer to a general SureShot Books FAQ / policy question.",
    _obj({"question": _S}, ["question"]),
)
_register(
    "escalate_to_human", EscalateArgs, _escalate,
    "Hand the call to a human customer service agent and flag for follow-up.",
    _obj({"reason": _S, "summary": _S}, ["reason"]),
)

# ── ElevenLabs-aligned tools (business source of truth) ─────────────────────
_register(
    "normalize_voice_intent", NormalizeVoiceIntentArgs, _normalize_voice_intent,
    "Normalize unclear voice phrases in SureShot context. Maps 'ordinary' to "
    "'order' when appropriate. Returns structured intent only — do not answer "
    "the customer from this tool.",
    _obj({"text": _S, "context": _S}, ["text"]),
)
_register(
    "get_order", GetOrderArgs, _get_order,
    "Look up order status, tracking, fulfillment, payment, refund, subtotal, "
    "shipping method/cost, cancellation eligibility. Requires verification for "
    "private details.",
    _obj({"order_number": _S, "email": _S, "phone": _S}, []),
)
_register(
    "catalog_search", CatalogSearchArgs, _catalog_search,
    "Search SureShot Books catalog by title, author, ISBN, SKU, or keyword. "
    "Authoritative for price, availability, stock/backorder. Never guess stock.",
    _obj({"query": {**_S, "description": "Title, author, ISBN, SKU, or keyword."},
          "limit": {**_I, "default": 5}}, ["query"]),
)
_register(
    "calculate_pricing", CalculatePricingArgs, _calculate_pricing,
    "Retrieve subtotal before shipping, shipping amount, method, and estimated "
    "total for an order. Never exposes internal fees.",
    _obj({"order_number": _S, "email": _S, "phone": _S}, []),
)
_register(
    "check_facility_approval", CheckFacilityApprovalArgs, _check_facility_approval,
    "Check if SureShot Books is approved to ship to a facility. Never guess.",
    _obj({"facility_name": _S, "city": _S, "state": _S, "order_number": _S},
         ["facility_name"]),
)
_register(
    "check_order_facility_restrictions", CheckOrderFacilityRestrictionsArgs,
    _check_order_facility_restrictions,
    "Check whether books in an order may be accepted or restricted by a facility. "
    "Uses client facility documents + Shopify order line items. Suggests allowed alternatives.",
    _obj({"order_number": _S, "facility_name": _S, "book_title": _S}, []),
)
_register(
    "reconcile_order_facility_books", ReconcileOrderFacilityBooksArgs,
    _reconcile_order_facility_books,
    "When some books arrived but others were returned/rejected by a correctional facility: "
    "load the order from Shopify, match each book against facility guideline documents, "
    "explain why each title was likely rejected, cite the facility website URL, and "
    "suggest similar allowed paperback alternatives from the catalog.",
    _obj({"order_number": _S, "facility_name": _S, "email": _S, "phone": _S},
         ["order_number"]),
)
_register(
    "address_update_instructions", AddressUpdateInstructionsArgs,
    _address_update_instructions,
    "Return customer-safe address update instructions (email Jessica).",
    _obj({"order_number": _S}, []),
)
_register(
    "cancel_order_request", CancelOrderRequestArgs, _cancel_order_request,
    "Check cancellation eligibility for an order. Enforces verification.",
    _obj({"order_number": _S, "email": _S}, ["order_number"]),
)
_register(
    "send_facility_payment_link", SendFacilityPaymentLinkArgs,
    _send_facility_payment_link,
    "Send secure link for facility/inmate/payment details. Only after email "
    "confirmed. Never speak the URL.",
    _obj({"email": _S, "order_number": _S}, ["email"]),
)
_register(
    "get_caller_info", GetCallerInfoArgs, _get_caller_info,
    "Identify returning caller by phone/session. Friendly recognition only — "
    "not full verification.",
    _obj({}, []),
)
_register(
    "save_caller_name", SaveCallerNameArgs, _save_caller_name,
    "Save caller name when provided and not already recognized.",
    _obj({"name": _S}, ["name"]),
)
_register(
    "escalate_to_customer_service", EscalateArgs, _escalate_to_customer_service,
    "Escalate to human customer service for unlisted books, unknown inventory, "
    "facility issues, or staff-needed actions.",
    _obj({"reason": _S, "summary": _S}, ["reason"]),
)
_register(
    "create_product_not_found_escalation",
    CreateProductNotFoundEscalationArgs,
    _create_product_not_found_escalation,
    "Email SureShot support when Shopify catalog search confirms a product is not "
    "available. Requires confirmed customer email.",
    _obj({
        "requested_value": {**_S, "description": "ISBN, title, newspaper, or magazine requested."},
        "customer_email": {**_S, "description": "Customer email for follow-up."},
        "requested_type": {**_S, "description": "isbn|title|author|newspaper|magazine|product|unknown"},
        "session_id": _S,
        "call_sid": _S,
        "customer_phone": _S,
        "customer_name": _S,
        "quantity": {**_I, "description": "Quantity if known."},
        "facility_name": _S,
        "conversation_summary": _S,
        "reason": _S,
    }, ["requested_value"]),
)


def tool_names() -> list[str]:
    return list(_TOOLS.keys())


def customer_facing_tool_names() -> list[str]:
    return [name for name in _TOOLS if name not in _INTERNAL_ONLY_TOOLS]


def tool_specs() -> list[dict]:
    """Return OpenAI tool schemas for customer-facing tools only."""
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.schema,
            },
        }
        for t in _TOOLS.values()
        if t.name not in _INTERNAL_ONLY_TOOLS
    ]


async def dispatch(name: str, args: dict, session: "SessionState | None") -> str:
    """
    Validate and execute a canonical tool. Always returns a JSON string and
    never raises — failures become safe error JSON.
    """
    tool = _TOOLS.get(name)
    if tool is None:
        logger.warning("llm_tool_unknown name=%s", name)
        return _err(f"Tool '{name}' is not available.")

    safe_args = dict(args or {})
    if name in ("send_payment_link", "create_checkout"):
        for key in ("email", "customer_email", "to_email"):
            safe_args.pop(key, None)

    try:
        validated = tool.model(**safe_args)
    except ValidationError as exc:
        logger.info("llm_tool_invalid_args name=%s errors=%d", name, len(exc.errors()))
        return _err("Invalid tool arguments.")

    sid = getattr(session, "call_sid", "")[:6] if session else "none"
    logger.info("llm_tool_call sid=%s name=%s arg_keys=%s", sid, name, sorted(safe_args.keys()))

    from .tool_runtime_gates import gate_tool_call

    gate = gate_tool_call(name, session)
    if gate is not None and not gate.allowed:
        logger.info(
            "llm_tool_gated sid=%s name=%s reason=%s",
            sid, name, gate.reason,
        )
        return gate.tool_json

    try:
        result = await tool.impl(validated, session)
        return result if isinstance(result, str) else json.dumps(result)
    except Exception:  # noqa: BLE001 — tools must never break the call
        logger.exception("llm_tool_error name=%s", name)
        return _err("That tool is temporarily unavailable.")
