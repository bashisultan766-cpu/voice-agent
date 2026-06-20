"""
Tool: calculate_pricing
Version: v2

Purpose:
    Calculate subtotal, shipping cost, and estimated total for a set of items.

    Three fields are always clearly separate:
        subtotal      — sum of (unit price × quantity) for all items
        shipping_cost — flat rate for the chosen method; null when unknown
        total         — subtotal + shipping_cost exactly; null when shipping unknown

    Hard business rules:
        - NEVER output "processing fee", "handling fee", or any hidden fee.
        - Only customer-facing fields: subtotal, shipping_cost, total.
        - If shipping cannot be determined: return shipping_cost=null, total=null.
          Do NOT invent a shipping number.

    suggested_response phrasing (required by agent prompt):
        Known shipping  → "The subtotal before shipping is $X. The subtotal does
                           not include shipping. Shipping via {method} is ${rate},
                           bringing your estimated total to ${total}."
        Unknown shipping → "The subtotal before shipping is $X. The subtotal does
                            not include shipping. Shipping cost depends on the
                            method and destination — ..."

    Two-layer architecture:
        MOCK:  MockPricingCalculator  (active — flat rates per method)
        REAL:  RealPricingCalculator  (disabled — calls internal pricing API)

    Shipping is unknown when neither shipping_method nor zip_code is provided.
"""
from __future__ import annotations

import logging
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1 — Domain models
# ─────────────────────────────────────────────────────────────────────────────

ShippingMethod = Literal["media_mail", "priority_mail", "standard"]

_FORBIDDEN_TERMS = ("processing fee", "handling fee", "service fee", "hidden fee")


class PricingLineItem(BaseModel):
    variant_id: str
    quantity: int = Field(1, ge=1)
    price: Optional[str] = None    # unit price string e.g. "15.95"; None → unknown
    title: Optional[str] = None    # display only — not used in arithmetic

    @field_validator("price")
    @classmethod
    def validate_price(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        try:
            val = Decimal(v.strip())
            if val < 0:
                raise ValueError("price cannot be negative")
            return f"{val:.2f}"
        except InvalidOperation:
            raise ValueError(f"invalid price format: {v!r}")


class PricingBreakdown(BaseModel):
    """
    subtotal is always present (sum of priced items; "0.00" if no prices given).
    shipping_cost, shipping_method, and total are null when shipping is unknown.
    total = subtotal + shipping_cost exactly — no other arithmetic.
    """
    subtotal: str                          # e.g. "28.94"
    shipping_cost: Optional[str] = None   # null → unknown
    shipping_method: Optional[str] = None # human-readable; null → unknown
    total: Optional[str] = None           # null → unknown
    shipping_known: bool
    items_count: int
    currency: str = "USD"
    source: Literal["mock", "real"] = "mock"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 2 — Request model
# ─────────────────────────────────────────────────────────────────────────────


class CalculatePricingRequest(BaseModel):
    items: list[PricingLineItem] = Field(..., min_length=1)
    shipping_method: Optional[ShippingMethod] = Field(
        None,
        description="Omit when method is not yet chosen — shipping returned as unknown.",
    )
    zip_code: Optional[str] = Field(
        None,
        description="Destination zip code — used in real mode for zone-based rates.",
    )

    @field_validator("zip_code")
    @classmethod
    def clean_zip(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        return v or None


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 3 — Business logic (pure, zero I/O)
# ─────────────────────────────────────────────────────────────────────────────


def _sum_items(items: list[PricingLineItem]) -> Optional[Decimal]:
    """Sum (price × qty) for all items. Returns None if any price is missing."""
    total = Decimal("0")
    for item in items:
        if item.price is None:
            return None
        try:
            total += Decimal(item.price) * item.quantity
        except InvalidOperation:
            return None
    return total


def _shipping_determinable(
    shipping_method: Optional[ShippingMethod],
    zip_code: Optional[str],
) -> bool:
    """
    Shipping is determinable when a method is provided (mock flat rate)
    OR a zip code is provided (real mode zone lookup).
    Neither → unknown.
    """
    return shipping_method is not None or zip_code is not None


def _assert_no_hidden_fees(breakdown: PricingBreakdown) -> None:
    """Hard guard: raise if any forbidden fee term appears anywhere in the output."""
    check_fields = [breakdown.shipping_method or ""]
    for value in check_fields:
        for term in _FORBIDDEN_TERMS:
            if term.lower() in value.lower():
                raise ValueError(
                    f"Forbidden term '{term}' detected in pricing output. "
                    "Only subtotal, shipping_cost, and total may be exposed."
                )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4 — Voice summary formatter (pure function, zero I/O)
# ─────────────────────────────────────────────────────────────────────────────


def _format_voice_summary(breakdown: PricingBreakdown) -> str:
    subtotal = f"${breakdown.subtotal}"

    if not breakdown.shipping_known:
        return (
            f"The subtotal before shipping is {subtotal}. "
            "The subtotal does not include shipping. "
            "Shipping cost depends on the method and destination — "
            "I can give you the exact total once we confirm how you'd like it shipped."
        )

    return (
        f"The subtotal before shipping is {subtotal}. "
        "The subtotal does not include shipping. "
        f"Shipping via {breakdown.shipping_method} is ${breakdown.shipping_cost}, "
        f"bringing your estimated total to ${breakdown.total}."
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 5 — MOCK LAYER  (replace with RealPricingCalculator when ready)
#
# Flat rates — no zone calculation in mock:
#   media_mail    → USPS Media Mail    $4.99
#   priority_mail → USPS Priority Mail $9.99
#   standard      → Standard Shipping  $4.99
#
# Shipping unknown when neither shipping_method nor zip_code provided.
# If zip_code given but no method: default to USPS Media Mail (books).
# ─────────────────────────────────────────────────────────────────────────────

_MOCK_RATES: dict[str, tuple[str, Decimal]] = {
    "media_mail":    ("USPS Media Mail",    Decimal("4.99")),
    "priority_mail": ("USPS Priority Mail", Decimal("9.99")),
    "standard":      ("Standard Shipping",  Decimal("4.99")),
}


class MockPricingCalculator:
    @staticmethod
    def calculate(req: CalculatePricingRequest) -> PricingBreakdown:
        items_count = sum(item.quantity for item in req.items)
        subtotal_dec = _sum_items(req.items)
        subtotal_str = f"{subtotal_dec:.2f}" if subtotal_dec is not None else "0.00"

        if not _shipping_determinable(req.shipping_method, req.zip_code):
            return PricingBreakdown(
                subtotal=subtotal_str,
                shipping_cost=None,
                shipping_method=None,
                total=None,
                shipping_known=False,
                items_count=items_count,
                source="mock",
            )

        method_key: str = req.shipping_method or "media_mail"
        method_name, rate = _MOCK_RATES[method_key]

        if subtotal_dec is None:
            # Prices missing — can quote shipping rate but not total
            return PricingBreakdown(
                subtotal="0.00",
                shipping_cost=f"{rate:.2f}",
                shipping_method=method_name,
                total=None,
                shipping_known=True,
                items_count=items_count,
                source="mock",
            )

        total_dec = subtotal_dec + rate
        return PricingBreakdown(
            subtotal=subtotal_str,
            shipping_cost=f"{rate:.2f}",
            shipping_method=method_name,
            total=f"{total_dec:.2f}",
            shipping_known=True,
            items_count=items_count,
            source="mock",
        )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 6 — REAL PATH PLACEHOLDER (disabled — interface contract only)
# ─────────────────────────────────────────────────────────────────────────────


class RealPricingCalculator:
    """
    Interface contract for live shipping rate lookup. NOT YET IMPLEMENTED.
    Real path: POST to AGENT_API_BASE/pricing with items + zip_code,
    receive zone-based USPS rates, return PricingBreakdown.
    """

    def __init__(self, api_base: str, api_key: str) -> None:
        self._api_base = api_base
        self._api_key = api_key

    async def calculate(self, req: CalculatePricingRequest) -> PricingBreakdown:
        raise NotImplementedError(
            "RealPricingCalculator is not yet implemented. "
            "Keep SHOPIFY_USE_MOCK=True or implement this method."
        )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 7 — Resolver
# ─────────────────────────────────────────────────────────────────────────────


async def _resolve_pricing(
    req: CalculatePricingRequest,
    api_base: Optional[str],
    api_key: Optional[str],
) -> PricingBreakdown:
    """Route to mock or real calculator based on API configuration."""
    use_real = bool(api_base and api_key)

    if use_real:
        try:
            calc = RealPricingCalculator(api_base, api_key)  # type: ignore[arg-type]
            return await calc.calculate(req)
        except NotImplementedError:
            logger.warning("RealPricingCalculator not implemented — falling back to mock")
        except Exception as exc:
            logger.error(
                "RealPricingCalculator.calculate() failed: %s — falling back to mock", exc
            )

    logger.debug("calculate_pricing: using mock calculator")
    return MockPricingCalculator.calculate(req)


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 8 — Tool class
# ─────────────────────────────────────────────────────────────────────────────


class CalculatePricingTool(BaseTool):
    name = "calculate_pricing"
    description = (
        "Calculate subtotal, shipping cost, and estimated total for a set of items. "
        "Returns subtotal (before shipping), shipping_cost, and total as separate fields. "
        "total = subtotal + shipping_cost exactly — no hidden fees. "
        "Provide shipping_method when known. Omit it to receive shipping as unknown. "
        "Call this when the customer asks about price, cost, or order total."
    )
    parameters = {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "description": "Items to price",
                "minItems": 1,
                "items": {
                    "type": "object",
                    "properties": {
                        "variant_id": {"type": "string"},
                        "quantity":   {"type": "integer", "minimum": 1},
                        "price":      {"type": "string", "description": "Unit price e.g. '15.95'"},
                        "title":      {"type": "string", "description": "Product title (display only)"},
                    },
                    "required": ["variant_id", "quantity"],
                },
            },
            "shipping_method": {
                "type": "string",
                "enum": ["media_mail", "priority_mail", "standard"],
                "description": (
                    "Shipping method. Omit if not yet chosen — "
                    "shipping will be returned as unknown."
                ),
            },
            "zip_code": {
                "type": "string",
                "description": "Destination zip code for zone-based rate lookup.",
            },
        },
        "required": ["items"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        try:
            req = CalculatePricingRequest(**args)
        except Exception as exc:
            return self.error_result(
                voice_summary=(
                    "I need the item details to calculate a price. "
                    "Could you confirm what you'd like to order?"
                ),
                error=f"Invalid input: {exc}",
            )

        try:
            api_base = getattr(context.agent_config, "internal_api_url", None)
            api_key = getattr(context.agent_config, "internal_api_key", None)
            breakdown = await _resolve_pricing(req, api_base, api_key)
        except Exception as exc:
            logger.error("calculate_pricing failed: %s", exc, exc_info=True)
            return self.error_result(
                voice_summary=(
                    "I'm having trouble calculating the price right now. "
                    "Please try again in a moment."
                ),
                error=f"Pricing calculation failed: {exc}",
            )

        try:
            _assert_no_hidden_fees(breakdown)
        except ValueError as exc:
            logger.error("Hidden fee guard triggered: %s", exc)
            return self.error_result(
                voice_summary="I'm having trouble with the pricing right now. Please try again.",
                error=str(exc),
            )

        voice_summary = _format_voice_summary(breakdown)

        items_label = f"{breakdown.items_count} item{'s' if breakdown.items_count != 1 else ''}"
        if breakdown.shipping_known:
            message = (
                f"Pricing for {items_label}: subtotal ${breakdown.subtotal}, "
                f"shipping ${breakdown.shipping_cost} via {breakdown.shipping_method}, "
                f"total ${breakdown.total}."
            )
        else:
            message = (
                f"Pricing for {items_label}: subtotal ${breakdown.subtotal}, "
                "shipping unknown."
            )

        logger.info(
            "calculate_pricing: items=%d subtotal=%s shipping_known=%s method=%s total=%s",
            breakdown.items_count,
            breakdown.subtotal,
            breakdown.shipping_known,
            breakdown.shipping_method,
            breakdown.total,
        )

        return ToolResult(
            success=True,
            data={
                "success": True,
                "message": message,
                "suggested_response": voice_summary,
                "data": breakdown.model_dump(),
                "error": None,
            },
            voice_summary=voice_summary,
        )


# ── Self-register ─────────────────────────────────────────────────────────────

registry.register(CalculatePricingTool())
