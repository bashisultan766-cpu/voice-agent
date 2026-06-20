"""
Tool: get_order
Version: v2

Purpose:
    Look up an existing Shopify order by its order number.
    Returns full order details, cancel-eligibility ruling, and a
    voice-optimised summary the TTS engine can speak directly.

    This tool is deliberately split into three layers so the Shopify
    API can be wired in later without touching tool logic:

        ┌─────────────────────────────────────────────────┐
        │  GetOrderTool.execute()                         │
        │    ↓ validates input                            │
        │    ↓ calls _resolve_order()                     │
        │         ├─ MOCK:  MockOrderRepository (active)  │
        │         └─ REAL:  ShopifyOrderClient (disabled) │
        │    ↓ applies cancel-eligibility rules           │
        │    ↓ formats voice summary                      │
        │    ↓ returns ToolResult                         │
        └─────────────────────────────────────────────────┘

Cancel-eligibility is PURE BUSINESS LOGIC — no I/O, fully testable.

Example request:
    { "order_number": "1234" }
    { "order_number": "#1234" }
    { "order_number": "one two three four" }   ← voice input, normalised

Example response (in ToolResult.data):
    {
        "success": true,
        "message": "Order #1234 found.",
        "data": {
            "found": true,
            "order_number": "1234",
            "order_id": "shopify_5678",
            "financial_status": "paid",
            "fulfillment_status": "fulfilled",
            "created_at": "2026-06-10T14:23:00Z",
            "subtotal": "15.95",
            "shipping_cost": "4.99",
            "total": "20.94",
            "currency": "USD",
            "items": [
                {
                    "title": "A Thug's Heartbeat",
                    "quantity": 1,
                    "price": "15.95",
                    "variant_id": "var_001",
                    "sku": "ATH-001"
                }
            ],
            "shipping": {
                "method": "USPS First Class",
                "cost": "4.99",
                "tracking_number": "9400111899223456789012",
                "tracking_url": null,
                "address_line": null
            },
            "cancel_eligibility": {
                "can_cancel": false,
                "reason": "Order has already shipped.",
                "requires_human": false
            },
            "tags": ["voice-order"],
            "note": null,
            "source": "mock"
        },
        "error": null
    }
"""
from __future__ import annotations

import logging
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from ..ai.common.validators import clean_order_number
from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1 — Domain models
# ─────────────────────────────────────────────────────────────────────────────

FinancialStatus = Literal[
    "pending", "authorized", "paid",
    "partially_refunded", "refunded", "voided",
]

FulfillmentStatus = Literal[
    "fulfilled", "unfulfilled", "partial", "restocked",
]


class OrderItem(BaseModel):
    title: str
    quantity: int
    price: str                        # formatted string e.g. "15.95"
    variant_id: Optional[str] = None  # Shopify variant ID (needed by other tools)
    sku: Optional[str] = None
    format: Optional[str] = None      # "paperback" / "hardcover" / "audiobook"
    publisher: Optional[str] = None   # Publisher name — used by facility restriction checks


class ShippingInfo(BaseModel):
    method: str
    cost: str
    tracking_number: Optional[str] = None
    tracking_url: Optional[str] = None
    address_line: Optional[str] = None   # "123 Main St, Anytown, TX 75001"


class CancelEligibility(BaseModel):
    can_cancel: bool
    reason: str        # human-readable explanation (fed to AI + voice)
    requires_human: bool  # True → escalate to CS instead of auto-cancelling


class GetOrderResponseData(BaseModel):
    """
    Full order payload returned inside ToolResult.data["data"].

    Fields are intentionally verbose so downstream tools (cancel, facility
    check, address update) can operate on this data without re-fetching.
    """

    found: bool
    order_number: str
    order_id: Optional[str] = None       # Shopify internal GID / numeric ID
    financial_status: Optional[FinancialStatus] = None
    fulfillment_status: Optional[FulfillmentStatus] = None
    created_at: Optional[str] = None     # ISO-8601
    subtotal: str = "0.00"
    shipping_cost: str = "0.00"
    total: str = "0.00"
    currency: str = "USD"
    items: list[OrderItem] = Field(default_factory=list)
    shipping: Optional[ShippingInfo] = None
    cancel_eligibility: CancelEligibility = Field(
        default_factory=lambda: CancelEligibility(
            can_cancel=False,
            reason="Order not found.",
            requires_human=False,
        )
    )
    tags: list[str] = Field(default_factory=list)
    note: Optional[str] = None
    source: Literal["mock", "shopify"] = "mock"

    # Privacy-sensitive fields — always masked in the response payload
    # unless the caller has been verified (session_state.caller_verified=True)
    customer_email: Optional[str] = None
    payment_last_four: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 2 — Request model
# ─────────────────────────────────────────────────────────────────────────────


class GetOrderRequest(BaseModel):
    """
    Accepted inputs:
        "1234"         — plain number
        "#1234"        — Shopify display format
        "one two three four" — voice dictation (normalised to "1234")
    """

    order_number: str = Field(
        ...,
        description=(
            "Order number — plain digits, '#'-prefixed, or spoken as words "
            "(e.g. 'one two three four'). Will be normalised automatically."
        ),
    )

    @field_validator("order_number")
    @classmethod
    def normalise(cls, v: str) -> str:
        cleaned = clean_order_number(v)
        if not cleaned:
            raise ValueError(
                f"Cannot extract a valid order number from {v!r}. "
                "Please provide the numeric order number."
            )
        return cleaned


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 3 — Cancel-eligibility (pure business rules, zero I/O)
# ─────────────────────────────────────────────────────────────────────────────


def _check_cancel_eligibility(
    financial_status: Optional[str],
    fulfillment_status: Optional[str],
) -> CancelEligibility:
    """
    Determine whether an order can be cancelled and who handles it.

    Rules (in priority order):
    1. Already voided/refunded → not cancellable
    2. Fully fulfilled (shipped) → not cancellable
    3. Partially fulfilled → requires human (CS team)
    4. Unfulfilled + paid/pending → auto-cancellable
    5. Any other state → escalate to CS
    """
    if financial_status == "voided":
        return CancelEligibility(
            can_cancel=False,
            reason="Order has already been cancelled.",
            requires_human=False,
        )
    if financial_status in ("refunded", "partially_refunded"):
        return CancelEligibility(
            can_cancel=False,
            reason="Order has already been refunded.",
            requires_human=False,
        )

    if fulfillment_status == "fulfilled":
        return CancelEligibility(
            can_cancel=False,
            reason="Order has already shipped and cannot be cancelled.",
            requires_human=False,
        )

    if fulfillment_status == "partial":
        return CancelEligibility(
            can_cancel=True,
            reason=(
                "Some items have already shipped. "
                "Cancellation of remaining items requires our customer service team."
            ),
            requires_human=True,
        )

    if fulfillment_status == "unfulfilled" and financial_status in ("paid", "pending", "authorized"):
        return CancelEligibility(
            can_cancel=True,
            reason="Order has not yet shipped and is eligible for cancellation.",
            requires_human=False,
        )

    return CancelEligibility(
        can_cancel=False,
        reason=(
            "Unable to determine cancellation eligibility automatically. "
            "Please contact our customer service team."
        ),
        requires_human=True,
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4 — Voice summary formatter (pure function, zero I/O)
# ─────────────────────────────────────────────────────────────────────────────


def _format_voice_summary(order: GetOrderResponseData) -> str:
    """Return a short (1-3 sentence) string for TTS."""
    num = order.order_number

    if not order.found:
        return (
            f"I wasn't able to find order number {num}. "
            "Could you double-check the number for me?"
        )

    status = order.fulfillment_status
    total = f"${order.total}"

    if status == "fulfilled":
        tracking = order.shipping.tracking_number if order.shipping else None
        base = f"Order {num} has shipped."
        if tracking:
            spaced = " ".join(tracking)
            return (
                f"{base} Your tracking number is {spaced}. "
                f"The total was {total}."
            )
        return f"{base} The total was {total}."

    if status == "unfulfilled":
        if order.cancel_eligibility.can_cancel:
            return (
                f"Order {num} is still being processed — it hasn't shipped yet. "
                f"The total is {total}. "
                "Would you like to cancel or make any changes?"
            )
        return (
            f"Order {num} is still being processed. "
            f"The total is {total}."
        )

    if status == "partial":
        return (
            f"Order {num} is partially shipped. "
            "Some items are on their way and others are still being prepared. "
            "I can connect you with our customer service team if you need changes."
        )

    if status == "restocked":
        return (
            f"Order {num} was cancelled and the items have been restocked. "
            "If you expect a refund, please allow 5 to 7 business days."
        )

    return (
        f"Order {num} has a status of {status}. "
        f"The total is {total}. "
        "Would you like more details or help with anything else?"
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4b — Privacy masking helpers
# ─────────────────────────────────────────────────────────────────────────────


def _mask_email(email: str) -> str:
    """j***@domain.com — first char of local part visible, rest replaced."""
    if not email or "@" not in email:
        return "***"
    local, domain = email.split("@", 1)
    return f"{local[:1]}***@{domain}"


def _mask_last_four(last_four: str) -> str:
    """Replace all digits with * when caller is not verified."""
    return "****"


def _apply_privacy(
    order: "GetOrderResponseData",
    verified: bool,
) -> tuple[Optional[str], Optional[str]]:
    """
    Return (display_email, display_last_four) according to verification state.
    verified=False  → always masked (default / safe)
    verified=True   → full email, last-4 visible
    """
    email = order.customer_email
    last_four = order.payment_last_four

    if not verified:
        return (
            _mask_email(email) if email else None,
            last_four,   # last-4 is never sensitive — safe to show unverified
        )
    return email, last_four


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 5 — MOCK LAYER  (temporary — replace with ShopifyOrderClient)
#
# Scenarios by last digit of order number:
#   0-3  → Fulfilled / shipped   (tracking number present)
#   4-6  → Unfulfilled / pending (cancellable)
#   7-8  → Partially fulfilled   (requires human to cancel)
#   9    → Order not found
# ─────────────────────────────────────────────────────────────────────────────

_MOCK_ITEMS_FULFILLED: list[OrderItem] = [
    OrderItem(
        title="A Thug's Heartbeat: Rocko's Street Justice",
        quantity=1,
        price="15.95",
        variant_id="var_001",
        sku="ATH-001",
        format="paperback",
        publisher="G-Unit Books / Cash Money Content",
    ),
]

_MOCK_ITEMS_UNFULFILLED: list[OrderItem] = [
    OrderItem(
        title="Tears of a Hustler",
        quantity=1,
        price="12.99",
        variant_id="var_004",
        sku="TOH-004",
        format="paperback",
        publisher="Good2Go Publishing",
    ),
    OrderItem(
        title="Hood Rich",
        quantity=1,
        price="14.99",
        variant_id="var_002",
        sku="HR-002",
        format="hardcover",          # triggers not_accepted at paperback-only facilities
        publisher="Urban Books",
    ),
]

_MOCK_ITEMS_PARTIAL: list[OrderItem] = [
    OrderItem(
        title="Street Love",
        quantity=1,
        price="16.50",
        variant_id="var_003",
        sku="SL-003",
        format="paperback",
        publisher=None,              # unknown publisher → needs_review at restrictive facilities
    ),
    OrderItem(
        title="A Thug's Heartbeat: Rocko's Street Justice",
        quantity=1,
        price="15.95",
        variant_id="var_001",
        sku="ATH-001",
        format="paperback",
        publisher="G-Unit Books / Cash Money Content",
    ),
]


class MockOrderRepository:
    """
    In-memory order store for development and testing.
    Replace with ShopifyOrderClient once the API is ready.
    """

    @staticmethod
    def get(order_number: str) -> GetOrderResponseData:
        last_digit = int(order_number[-1]) if order_number[-1:].isdigit() else 0

        if last_digit == 9:
            return GetOrderResponseData(
                found=False,
                order_number=order_number,
                source="mock",
            )

        if last_digit <= 3:
            return GetOrderResponseData(
                found=True,
                order_number=order_number,
                order_id=f"mock_{order_number}",
                financial_status="paid",
                fulfillment_status="fulfilled",
                created_at="2026-06-10T14:23:00Z",
                subtotal="15.95",
                shipping_cost="4.99",
                total="20.94",
                currency="USD",
                items=_MOCK_ITEMS_FULFILLED,
                shipping=ShippingInfo(
                    method="USPS First Class",
                    cost="4.99",
                    tracking_number="9400111899223456789012",
                ),
                tags=["voice-order"],
                source="mock",
                customer_email="jessica@example.com",
                payment_last_four="4242",
            )

        if last_digit <= 6:
            return GetOrderResponseData(
                found=True,
                order_number=order_number,
                order_id=f"mock_{order_number}",
                financial_status="paid",
                fulfillment_status="unfulfilled",
                created_at="2026-06-17T09:15:00Z",
                subtotal="27.98",
                shipping_cost="4.99",
                total="32.97",
                currency="USD",
                items=_MOCK_ITEMS_UNFULFILLED,
                tags=["voice-order"],
                source="mock",
                customer_email="jessica@example.com",
                payment_last_four="4242",
            )

        return GetOrderResponseData(
            found=True,
            order_number=order_number,
            order_id=f"mock_{order_number}",
            financial_status="paid",
            fulfillment_status="partial",
            created_at="2026-06-14T11:00:00Z",
            subtotal="32.45",
            shipping_cost="4.99",
            total="37.44",
            currency="USD",
            items=_MOCK_ITEMS_PARTIAL,
            shipping=ShippingInfo(
                method="USPS Media Mail",
                cost="4.99",
                tracking_number="9400111899223456700001",
            ),
            tags=["voice-order", "partial-ship"],
            source="mock",
            customer_email="jessica@example.com",
            payment_last_four="4242",
        )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 6 — SHOPIFY API PLACEHOLDER  (disabled — interface contract only)
# ─────────────────────────────────────────────────────────────────────────────


class ShopifyOrderClient:
    """Interface contract for the real Shopify Admin API client. NOT YET IMPLEMENTED."""

    def __init__(self, domain: str, access_token: str) -> None:
        self._domain = domain
        self._access_token = access_token

    async def get(self, order_number: str) -> GetOrderResponseData:
        raise NotImplementedError(
            "ShopifyOrderClient.get() is not yet implemented. "
            "Ensure SHOPIFY_USE_MOCK is true or implement this method."
        )


def _map_shopify_order(raw: dict[str, Any]) -> GetOrderResponseData:
    """Map a raw Shopify Admin API order dict to GetOrderResponseData. NOT YET ACTIVE."""
    line_items = [
        OrderItem(
            title=item.get("title", "Unknown item"),
            quantity=item.get("quantity", 1),
            price=item.get("price", "0.00"),
            variant_id=str(item.get("variant_id", "")) or None,
            sku=item.get("sku") or None,
        )
        for item in raw.get("line_items", [])
    ]

    shipping_lines = raw.get("shipping_lines", [])
    shipping_cost = shipping_lines[0].get("price", "0.00") if shipping_lines else "0.00"
    shipping_method = shipping_lines[0].get("title", "Standard") if shipping_lines else "Standard"

    fulfillments = raw.get("fulfillments", [])
    tracking_number: Optional[str] = None
    if fulfillments:
        tracking_number = fulfillments[0].get("tracking_number")

    return GetOrderResponseData(
        found=True,
        order_number=str(raw.get("order_number", "")),
        order_id=str(raw.get("id", "")),
        financial_status=raw.get("financial_status"),
        fulfillment_status=raw.get("fulfillment_status") or "unfulfilled",
        created_at=raw.get("created_at"),
        subtotal=raw.get("subtotal_price", "0.00"),
        shipping_cost=shipping_cost,
        total=raw.get("total_price", "0.00"),
        currency=raw.get("currency", "USD"),
        items=line_items,
        shipping=ShippingInfo(
            method=shipping_method,
            cost=shipping_cost,
            tracking_number=tracking_number,
        ) if fulfillments or shipping_lines else None,
        tags=[t.strip() for t in raw.get("tags", "").split(",") if t.strip()],
        note=raw.get("note"),
        source="shopify",
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 7 — Data resolver
# ─────────────────────────────────────────────────────────────────────────────


async def _resolve_order(
    order_number: str,
    shopify_domain: Optional[str],
    shopify_access_token: Optional[str],
) -> GetOrderResponseData:
    """Route to mock or real Shopify based on credential presence."""
    use_real = bool(shopify_domain and shopify_access_token)

    if use_real:
        try:
            client = ShopifyOrderClient(shopify_domain, shopify_access_token)  # type: ignore[arg-type]
            return await client.get(order_number)
        except NotImplementedError:
            logger.warning(
                "ShopifyOrderClient not implemented — falling back to mock for order %s",
                order_number,
            )
        except Exception as exc:
            logger.error(
                "ShopifyOrderClient.get(%s) failed: %s — falling back to mock",
                order_number,
                exc,
            )

    logger.debug("get_order: using mock data for order %s", order_number)
    return MockOrderRepository.get(order_number)


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 8 — Tool class
# ─────────────────────────────────────────────────────────────────────────────


class GetOrderTool(BaseTool):
    name = "get_order"
    description = (
        "Look up an existing order by order number. "
        "Returns status, items, shipping info, total price, tracking number, "
        "and whether the order can be cancelled. "
        "Accepts plain digits, '#'-prefixed numbers, or spoken number words."
    )
    parameters = {
        "type": "object",
        "properties": {
            "order_number": {
                "type": "string",
                "description": (
                    "The order number to look up. "
                    "Examples: '1234', '#1234', 'one two three four'."
                ),
            },
        },
        "required": ["order_number"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        try:
            req = GetOrderRequest(**args)
        except Exception as exc:
            return self.error_result(
                voice_summary=(
                    "I didn't quite catch the order number. "
                    "Could you repeat it for me?"
                ),
                error=f"Invalid input: {exc}",
            )

        order_number = req.order_number

        try:
            order = await _resolve_order(
                order_number=order_number,
                shopify_domain=context.agent_config.shopify_domain,
                shopify_access_token=context.agent_config.shopify_access_token,
            )
        except Exception as exc:
            logger.error("get_order(%s) fetch error: %s", order_number, exc, exc_info=True)
            return self.error_result(
                voice_summary=(
                    "I'm having trouble looking up that order right now. "
                    "Please try again in a moment."
                ),
                error=f"Order fetch failed: {exc}",
            )

        if order.found:
            order.cancel_eligibility = _check_cancel_eligibility(
                financial_status=order.financial_status,
                fulfillment_status=order.fulfillment_status,
            )

        voice_summary = _format_voice_summary(order)

        # Privacy masking — read verification status from session; default unverified
        verified: bool = getattr(context.session_state, "caller_verified", False)
        display_email, display_last_four = _apply_privacy(order, verified)

        logger.info(
            "get_order: order=%s found=%s status=%s/%s can_cancel=%s source=%s verified=%s",
            order_number,
            order.found,
            order.financial_status,
            order.fulfillment_status,
            order.cancel_eligibility.can_cancel if order.found else "n/a",
            order.source,
            verified,
        )

        message = (
            f"Order #{order_number} found."
            if order.found
            else f"Order #{order_number} not found."
        )

        order_data = order.model_dump()
        order_data["customer_email"] = display_email
        order_data["payment_last_four"] = display_last_four

        return ToolResult(
            success=True,
            data={
                "success": True,
                "message": message,
                "suggested_response": voice_summary,
                "data": order_data,
                "error": None,
            },
            voice_summary=voice_summary,
        )


# ── Self-register ─────────────────────────────────────────────────────────────

registry.register(GetOrderTool())
