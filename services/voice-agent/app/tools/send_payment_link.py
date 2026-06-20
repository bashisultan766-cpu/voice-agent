"""
Tool: send_payment_link
Version: v2

Purpose:
    Create a Shopify draft order for the customer's selected items and
    dispatch the payment link to their confirmed email address.

    This tool is a CHECKOUT GATE — it refuses to run unless the caller's
    email address has been verbally confirmed (email_confirmed=True).

SAFE BUILD PHASE — NO EXTERNAL CALLS:
    Both feature flags are False. All execution paths are internal only.

        USE_REAL_SHOPIFY = False  →  MockPaymentLinkGenerator  (active)
        USE_REAL_EMAIL   = False  →  _email_stub()             (active, logs only)

Data flow:

    ┌────────────────────────────────────────────────────────────────────┐
    │  SendPaymentLinkTool.execute()                                     │
    │    ↓ gate: email_confirmed == False  → refuse + voice prompt       │
    │    ↓ validate request (Pydantic)                                   │
    │    ↓ _resolve_payment_link()                                       │
    │         ├── STEP 1 — draft order creation                          │
    │         │     USE_REAL_SHOPIFY=False → MockPaymentLinkGenerator    │
    │         │     USE_REAL_SHOPIFY=True  → ShopifyDraftOrderClient     │
    │         │                             (disabled, falls back to mock)│
    │         │                                                          │
    │         └── STEP 2 — email dispatch (independent of step 1)       │
    │               USE_REAL_EMAIL=False → _email_stub()  (logs only)   │
    │               USE_REAL_EMAIL=True  → _email_real()  (disabled)    │
    │                                                                    │
    │    ↓ _format_voice_summary()                                       │
    │    ↓ ToolResult + state_update                                     │
    └────────────────────────────────────────────────────────────────────┘
"""
from __future__ import annotations

import logging
import secrets
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from ..ai.common.validators import is_valid_email
from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# FEATURE FLAGS
# ─────────────────────────────────────────────────────────────────────────────

USE_REAL_SHOPIFY: bool = False
USE_REAL_EMAIL: bool = False

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1 — Domain models
# ─────────────────────────────────────────────────────────────────────────────


class PaymentLineItem(BaseModel):
    """A single item to include in the draft order."""

    variant_id: str = Field(..., description="Shopify variant ID")
    quantity: int = Field(..., ge=1, le=50, description="Units ordered (1–50)")
    title: Optional[str] = Field(None, description="Display name — used in voice summary")
    price: Optional[str] = Field(None, description="Unit price string e.g. '15.95'")

    @field_validator("variant_id")
    @classmethod
    def strip_variant_id(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("variant_id cannot be empty")
        return v

    @field_validator("price")
    @classmethod
    def normalise_price(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        try:
            val = Decimal(v.strip())
            if val < 0:
                raise ValueError("price cannot be negative")
            return f"{val:.2f}"
        except InvalidOperation:
            raise ValueError(f"invalid price format: {v!r}")


EmailMode = Literal["stub", "resend", "skipped"]
OrderMode = Literal["mock", "shopify"]


class SendPaymentLinkData(BaseModel):
    order_name: str
    draft_order_id: str
    checkout_url: str
    invoice_url: str
    email_sent: bool
    email_sent_to: str
    email_mode: EmailMode = "stub"
    order_mode: OrderMode = "mock"
    expires_at: Optional[str] = None
    items_summary: str = ""
    subtotal_estimate: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 2 — Request model
# ─────────────────────────────────────────────────────────────────────────────


class SendPaymentLinkRequest(BaseModel):
    email: str = Field(..., description="Customer email address (must be confirmed)")
    email_confirmed: bool = Field(
        ..., description="True only after the caller verbally confirmed their email"
    )
    items: list[PaymentLineItem] = Field(
        ..., min_length=1, max_length=20, description="Items to order (1–20)"
    )
    customer_phone: Optional[str] = Field(
        None, description="Caller phone — logged only, never transmitted"
    )
    note: Optional[str] = Field(None, max_length=500, description="Internal order note")

    @field_validator("email")
    @classmethod
    def validate_and_normalise_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not is_valid_email(v):
            raise ValueError(f"invalid email address: {v!r}")
        return v


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 3 — Pure helpers
# ─────────────────────────────────────────────────────────────────────────────


def _estimate_total(items: list[PaymentLineItem]) -> Optional[str]:
    total = Decimal("0")
    for item in items:
        if item.price is None:
            return None
        try:
            total += Decimal(item.price) * item.quantity
        except InvalidOperation:
            return None
    return f"{total:.2f}"


def _build_items_summary(items: list[PaymentLineItem]) -> str:
    parts = [
        f"{item.title or 'item #' + item.variant_id} x{item.quantity}"
        for item in items
    ]
    return ", ".join(parts)


def _mask_email(email: str) -> str:
    if "@" not in email:
        return email
    local, domain = email.split("@", 1)
    if len(local) <= 2:
        return email
    return f"{local[:2]}...@{domain}"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4 — Voice summary formatter
# ─────────────────────────────────────────────────────────────────────────────


def _format_voice_summary(data: SendPaymentLinkData) -> str:
    masked = _mask_email(data.email_sent_to)

    if data.email_sent:
        item_part = f"Your order is for {data.items_summary}. " if data.items_summary else ""
        subtotal_part = (
            f"The subtotal before shipping is ${data.subtotal_estimate}. "
            if data.subtotal_estimate else ""
        )
        return (
            f"I've sent your payment link to {masked}. "
            f"{item_part}"
            f"{subtotal_part}"
            "Please check your email and click the link to complete your purchase."
        )

    return (
        f"I wasn't able to send the payment link right now. "
        f"Your order reference is {data.order_name}. "
        "Would you like me to try again, or would you prefer to speak with our team?"
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 5 — MOCK LAYER
# ─────────────────────────────────────────────────────────────────────────────


class MockPaymentLinkGenerator:
    @staticmethod
    def create_order(req: SendPaymentLinkRequest) -> SendPaymentLinkData:
        token = secrets.token_hex(3).upper()
        order_name = f"#D{token}"
        draft_order_id = f"mock_{secrets.token_hex(4)}"
        checkout_url = (
            f"https://sureshotbooks.myshopify.com/checkouts/mock/{draft_order_id}"
        )
        items_summary = _build_items_summary(req.items)
        subtotal_estimate = _estimate_total(req.items)

        logger.debug(
            "MockPaymentLinkGenerator: order=%s items=%r subtotal=%s",
            order_name,
            items_summary,
            subtotal_estimate,
        )

        return SendPaymentLinkData(
            order_name=order_name,
            draft_order_id=draft_order_id,
            checkout_url=checkout_url,
            invoice_url=checkout_url,
            email_sent=False,
            email_sent_to=req.email,
            email_mode="stub",
            order_mode="mock",
            items_summary=items_summary,
            subtotal_estimate=subtotal_estimate,
        )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 6 — EMAIL LAYER
# ─────────────────────────────────────────────────────────────────────────────


async def _email_stub(
    to: str,
    checkout_url: str,
    items_summary: str,
    total: Optional[str],
) -> bool:
    logger.info(
        "[EMAIL STUB — no email sent] to=%s | items=%s | total=%s | url=%s",
        to,
        items_summary,
        total or "n/a",
        checkout_url,
    )
    return True


async def _email_real(
    to: str,
    checkout_url: str,
    items_summary: str,
    total: Optional[str],
    resend_api_key: str,
    from_email: str,
) -> bool:
    # TODO: implement when email delivery is approved
    #
    #   from ..ai.common.notifications import send_email, payment_link_html
    #   html = payment_link_html(checkout_url=checkout_url, product_name=items_summary, ...)
    #   return await send_email(to=to, subject="Your SureShot Books Payment Link",
    #                           html=html, api_key=resend_api_key, from_email=from_email)
    raise NotImplementedError(
        "_email_real() is not yet implemented. Keep USE_REAL_EMAIL=False until this is ready."
    )


async def _dispatch_email(
    to: str,
    checkout_url: str,
    items_summary: str,
    total: Optional[str],
    resend_api_key: str = "",
    from_email: str = "",
) -> tuple[bool, EmailMode]:
    if USE_REAL_EMAIL:
        try:
            sent = await _email_real(to, checkout_url, items_summary, total, resend_api_key, from_email)
            return sent, "resend"
        except NotImplementedError:
            logger.warning("_email_real() not implemented — falling back to stub")
        except Exception as exc:
            logger.error("_email_real() failed: %s — falling back to stub", exc, exc_info=True)

    sent = await _email_stub(to, checkout_url, items_summary, total)
    return sent, "stub"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 7 — SHOPIFY API PLACEHOLDER
# ─────────────────────────────────────────────────────────────────────────────


class ShopifyDraftOrderClient:
    def __init__(self, domain: str, access_token: str) -> None:
        self._domain = domain
        self._access_token = access_token

    def create_order(self, req: SendPaymentLinkRequest) -> SendPaymentLinkData:
        raise NotImplementedError(
            "ShopifyDraftOrderClient.create_order() is not yet implemented. "
            "Keep USE_REAL_SHOPIFY=False until this is ready."
        )


def _map_shopify_draft_order(raw: dict[str, Any], email_sent_to: str) -> SendPaymentLinkData:
    line_items = raw.get("line_items", [])
    items_summary = ", ".join(
        f"{li.get('title', 'Item')} x{li.get('quantity', 1)}"
        for li in line_items
    )
    return SendPaymentLinkData(
        order_name=raw.get("name", "#DUNKNOWN"),
        draft_order_id=str(raw.get("id", "")),
        checkout_url=raw.get("invoice_url", ""),
        invoice_url=raw.get("invoice_url", ""),
        email_sent=False,
        email_sent_to=email_sent_to,
        email_mode="stub",
        order_mode="shopify",
        items_summary=items_summary,
        subtotal_estimate=raw.get("total_price"),
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 8 — Resolver (two-step: draft order → email dispatch)
# ─────────────────────────────────────────────────────────────────────────────


async def _create_draft_order(
    req: SendPaymentLinkRequest,
    shopify_domain: Optional[str],
    shopify_access_token: Optional[str],
) -> SendPaymentLinkData:
    use_real = USE_REAL_SHOPIFY and bool(shopify_domain and shopify_access_token)

    if use_real:
        try:
            client = ShopifyDraftOrderClient(shopify_domain, shopify_access_token)  # type: ignore[arg-type]
            return client.create_order(req)
        except NotImplementedError:
            logger.warning("ShopifyDraftOrderClient not implemented — falling back to mock")
        except Exception as exc:
            logger.error("ShopifyDraftOrderClient.create_order() failed: %s — falling back to mock", exc, exc_info=True)

    logger.debug("send_payment_link: draft order via MockPaymentLinkGenerator")
    return MockPaymentLinkGenerator.create_order(req)


async def _resolve_payment_link(
    req: SendPaymentLinkRequest,
    shopify_domain: Optional[str],
    shopify_access_token: Optional[str],
    resend_api_key: str = "",
    from_email: str = "",
) -> SendPaymentLinkData:
    order = await _create_draft_order(req, shopify_domain, shopify_access_token)

    email_sent, email_mode = await _dispatch_email(
        to=req.email,
        checkout_url=order.checkout_url,
        items_summary=order.items_summary,
        total=order.subtotal_estimate,
        resend_api_key=resend_api_key,
        from_email=from_email,
    )

    return order.model_copy(update={"email_sent": email_sent, "email_mode": email_mode})


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 9 — Tool class
# ─────────────────────────────────────────────────────────────────────────────


class SendPaymentLinkTool(BaseTool):
    name = "send_payment_link"
    description = (
        "Create a Shopify draft order and send the customer a payment link by email. "
        "ONLY call this after the caller has verbally confirmed their email address "
        "(email_confirmed must be true). "
        "Returns the draft order reference and email delivery status."
    )
    parameters = {
        "type": "object",
        "properties": {
            "email": {
                "type": "string",
                "description": "Customer email address — must be the verbally confirmed email",
            },
            "email_confirmed": {
                "type": "boolean",
                "description": "Set to true ONLY after the caller confirmed their email. Never call with false.",
            },
            "items": {
                "type": "array",
                "description": "Items to include in the order",
                "minItems": 1,
                "items": {
                    "type": "object",
                    "properties": {
                        "variant_id": {"type": "string", "description": "Shopify variant ID"},
                        "quantity": {"type": "integer", "minimum": 1, "description": "Number of units"},
                        "title": {"type": "string", "description": "Product title — included in voice summary"},
                        "price": {"type": "string", "description": "Unit price string e.g. '15.95'"},
                    },
                    "required": ["variant_id", "quantity"],
                },
            },
            "customer_phone": {"type": "string", "description": "Caller phone — logged only, not transmitted"},
            "note": {"type": "string", "description": "Optional internal note attached to the order"},
        },
        "required": ["email", "email_confirmed", "items"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        if not args.get("email_confirmed", False):
            logger.info("send_payment_link blocked — email not confirmed (session=%s)", context.session_id)
            return ToolResult(
                success=False,
                data={
                    "success": False,
                    "message": "Email confirmation required before creating payment link.",
                    "data": None,
                    "error": "email_confirmed is False",
                },
                voice_summary=(
                    "Before I send the payment link I need to confirm your email. "
                    "Could you please tell me your email address?"
                ),
                error="email_confirmed is False",
                state_update={"email_fsm_state": "COLLECTING"},
            )

        try:
            req = SendPaymentLinkRequest(**args)
        except Exception as exc:
            logger.warning("send_payment_link validation error: %s (session=%s)", exc, context.session_id)
            return self.error_result(
                voice_summary=(
                    "I'm missing some information to complete your order. "
                    "Could you confirm the item and your email address?"
                ),
                error=f"Validation failed: {exc}",
            )

        try:
            result = await _resolve_payment_link(
                req=req,
                shopify_domain=context.agent_config.shopify_domain,
                shopify_access_token=context.agent_config.shopify_access_token,
                resend_api_key=context.agent_config.resend_api_key or "",
                from_email=context.agent_config.from_email,
            )
        except Exception as exc:
            logger.error("send_payment_link unexpected error (session=%s): %s", context.session_id, exc, exc_info=True)
            return self.error_result(
                voice_summary=(
                    "I ran into a problem creating your order. "
                    "Let me connect you with our customer service team."
                ),
                error=f"Payment link creation failed: {exc}",
            )

        voice_summary = _format_voice_summary(result)

        logger.info(
            "send_payment_link: order=%s email_sent=%s email_mode=%s order_mode=%s items=%r subtotal=%s session=%s",
            result.order_name, result.email_sent, result.email_mode,
            result.order_mode, result.items_summary, result.subtotal_estimate, context.session_id,
        )

        if not result.email_sent:
            logger.warning(
                "send_payment_link: email delivery failed (session=%s order=%s)",
                context.session_id, result.order_name,
            )
            return ToolResult(
                success=False,
                data={
                    "success": False,
                    "message": f"Payment link created ({result.order_mode}) but email delivery failed to {req.email}.",
                    "suggested_response": voice_summary,
                    "data": result.model_dump(),
                    "error": "email_sent is False",
                },
                voice_summary=voice_summary,
                error="email_sent is False",
                state_update={"email_fsm_state": "EMAIL_FAILED"},
            )

        message = f"Payment link created ({result.order_mode}). Email dispatched ({result.email_mode}) to {req.email}."

        return ToolResult(
            success=True,
            data={
                "success": True,
                "message": message,
                "suggested_response": voice_summary,
                "data": result.model_dump(),
                "error": None,
            },
            voice_summary=voice_summary,
            state_update={
                "conversation_state": "CHECKOUT_SENT",
                "customer_email": req.email,
                "checkout_link_id": result.draft_order_id,
            },
        )


# ── Self-register ─────────────────────────────────────────────────────────────

registry.register(SendPaymentLinkTool())
