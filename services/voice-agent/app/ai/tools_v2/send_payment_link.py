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

The two steps are intentionally independent so they can be activated
at different times during the production rollout:
    - USE_REAL_SHOPIFY=False + USE_REAL_EMAIL=True  → test email only
    - USE_REAL_SHOPIFY=True  + USE_REAL_EMAIL=False → test Shopify only
    - USE_REAL_SHOPIFY=True  + USE_REAL_EMAIL=True  → full production

Example request:
    {
        "email": "customer@example.com",
        "email_confirmed": true,
        "items": [
            {
                "variant_id": "var_001",
                "quantity": 1,
                "title": "A Thug's Heartbeat",
                "price": "15.95"
            }
        ]
    }

Example response (ToolResult.data):
    {
        "success": true,
        "message": "Payment link created. Email dispatched (stub) to customer@example.com.",
        "data": {
            "order_name": "#DA1B2C",
            "draft_order_id": "mock_3f9a1c22",
            "checkout_url": "https://sureshotbooks.myshopify.com/checkouts/mock/3f9a1c22",
            "invoice_url": "https://sureshotbooks.myshopify.com/checkouts/mock/3f9a1c22",
            "email_sent": true,
            "email_sent_to": "customer@example.com",
            "email_mode": "stub",
            "order_mode": "mock",
            "expires_at": null,
            "items_summary": "A Thug's Heartbeat x1",
            "total_estimate": "15.95"
        },
        "error": null
    }
"""
from __future__ import annotations

import logging
import secrets
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from ..common.validators import is_valid_email
from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# FEATURE FLAGS
#
# Both flags are False during the safe architecture phase.
# Flip them independently when the corresponding integration is ready.
#
#   USE_REAL_SHOPIFY = False  →  MockPaymentLinkGenerator runs (no API calls)
#   USE_REAL_SHOPIFY = True   →  ShopifyDraftOrderClient runs (not yet implemented)
#
#   USE_REAL_EMAIL = False    →  _email_stub() runs (logs only, no HTTP)
#   USE_REAL_EMAIL = True     →  _email_real() runs (not yet implemented)
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
    """
    Full result payload placed inside ToolResult.data["data"].

    Downstream tools (cancel, facility payment) can read draft_order_id
    and checkout_url without re-fetching the order.
    """

    order_name: str                             # e.g. "#DA1B2C"
    draft_order_id: str                         # Shopify internal ID (or mock ID)
    checkout_url: str                           # The payment link
    invoice_url: str                            # Same as checkout_url for Shopify drafts
    email_sent: bool                            # Whether the email dispatch succeeded
    email_sent_to: str                          # Email address the link was sent to
    email_mode: EmailMode = "stub"              # Which email path ran
    order_mode: OrderMode = "mock"              # Which order creation path ran
    expires_at: Optional[str] = None            # ISO-8601 or null
    items_summary: str = ""                     # "A Thug's Heartbeat x1, Hood Rich x2"
    total_estimate: Optional[str] = None        # Sum of prices (pre-tax, pre-shipping)


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 2 — Request model
# ─────────────────────────────────────────────────────────────────────────────


class SendPaymentLinkRequest(BaseModel):
    """
    Validated input for send_payment_link.

    email_confirmed is NOT enforced here — execute() checks it first
    so the voice_summary is caller-friendly, not a raw Pydantic error.
    """

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
# SECTION 3 — Pure helpers (zero I/O, fully unit-testable)
# ─────────────────────────────────────────────────────────────────────────────


def _estimate_total(items: list[PaymentLineItem]) -> Optional[str]:
    """
    Sum price × quantity for all items.
    Returns None when any item is missing a price — no partial estimates.
    """
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
    """'A Thug's Heartbeat x1, Hood Rich x2'"""
    parts = [
        f"{item.title or 'item #' + item.variant_id} x{item.quantity}"
        for item in items
    ]
    return ", ".join(parts)


def _mask_email(email: str) -> str:
    """
    Partially mask email for TTS — avoids broadcasting full address on
    a recorded phone call.
    'customer@example.com' → 'cu...@example.com'
    """
    if "@" not in email:
        return email
    local, domain = email.split("@", 1)
    if len(local) <= 2:
        return email
    return f"{local[:2]}...@{domain}"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4 — Voice summary formatter (pure function, zero I/O)
# ─────────────────────────────────────────────────────────────────────────────


def _format_voice_summary(data: SendPaymentLinkData) -> str:
    """
    TTS-ready confirmation string — 1-3 sentences.

    Rules:
    - Mask email (privacy on recorded calls)
    - Confirm item(s) so caller knows what was ordered
    - Tell caller what to do next (check email)
    - Provide order reference if email failed
    """
    masked = _mask_email(data.email_sent_to)

    if data.email_sent:
        item_part = f"Your order is for {data.items_summary}. " if data.items_summary else ""
        total_part = f"The estimated total is ${data.total_estimate}. " if data.total_estimate else ""
        return (
            f"I've sent your payment link to {masked}. "
            f"{item_part}"
            f"{total_part}"
            "Please check your email and click the link to complete your purchase."
        )

    return (
        f"I had trouble sending the email right now. "
        f"Your order reference is {data.order_name}. "
        "Please call us back and we'll resend the payment link."
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 5 — MOCK LAYER  (primary path, USE_REAL_SHOPIFY = False)
#
# Creates a realistic draft order in memory — zero API calls.
# Returns email_sent=False; email dispatch is handled separately in step 2.
#
# DO NOT DELETE — this is the safe fallback for all environments.
# ─────────────────────────────────────────────────────────────────────────────


class MockPaymentLinkGenerator:
    """
    Generates a realistic Shopify-style draft order with no external calls.

    Draft order name:  #D + 6 uppercase hex chars  (e.g. #DA1B2C)
    Checkout URL:      Mimics Shopify checkout URL path
    email_sent:        Always starts as False — set by _dispatch_email() in step 2
    """

    @staticmethod
    def create_order(req: SendPaymentLinkRequest) -> SendPaymentLinkData:
        token = secrets.token_hex(3).upper()               # 6 hex chars → "A1B2C3"
        order_name = f"#D{token}"
        draft_order_id = f"mock_{secrets.token_hex(4)}"
        checkout_url = (
            f"https://sureshotbooks.myshopify.com/checkouts/mock/{draft_order_id}"
        )
        items_summary = _build_items_summary(req.items)
        total_estimate = _estimate_total(req.items)

        logger.debug(
            "MockPaymentLinkGenerator: order=%s items=%r total=%s",
            order_name,
            items_summary,
            total_estimate,
        )

        return SendPaymentLinkData(
            order_name=order_name,
            draft_order_id=draft_order_id,
            checkout_url=checkout_url,
            invoice_url=checkout_url,
            email_sent=False,           # populated by _dispatch_email()
            email_sent_to=req.email,
            email_mode="stub",          # updated by _dispatch_email()
            order_mode="mock",
            items_summary=items_summary,
            total_estimate=total_estimate,
        )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 6 — EMAIL LAYER  (independent of Shopify layer)
#
# _email_stub()  — active when USE_REAL_EMAIL = False  (logs only, no HTTP)
# _email_real()  — active when USE_REAL_EMAIL = True   (NOT YET IMPLEMENTED)
# _dispatch_email() — routes to stub or real based on USE_REAL_EMAIL
#
# The stub always returns True so voice_summary is positive.
# When USE_REAL_EMAIL flips to True, only _email_real() needs implementing.
# ─────────────────────────────────────────────────────────────────────────────


async def _email_stub(
    to: str,
    checkout_url: str,
    items_summary: str,
    total: Optional[str],
) -> bool:
    """
    Email stub — SAFE BUILD PHASE.

    Performs zero external calls. Logs what WOULD be sent so the output
    is verifiable in development without touching any mail service.

    Returns True to simulate successful delivery.
    """
    logger.info(
        "[EMAIL STUB — no email sent] to=%s | items=%s | total=%s | url=%s",
        to,
        items_summary,
        total or "n/a",
        checkout_url,
    )
    return True  # simulated success — no real delivery


async def _email_real(
    to: str,
    checkout_url: str,
    items_summary: str,
    total: Optional[str],
    resend_api_key: str,
    from_email: str,
) -> bool:
    """
    Real email delivery via Resend API.

    NOT YET ACTIVE.
    Set USE_REAL_EMAIL = True and implement this function when ready.

    Activation steps:
        1. Set USE_REAL_EMAIL = True
        2. Import and call common/notifications.send_email()
        3. Use common/notifications.payment_link_html() for the body
        4. Pass resend_api_key and from_email from agent_config
    """
    # TODO: implement when email delivery is approved
    #
    #   from ..common.notifications import send_email, payment_link_html
    #   html = payment_link_html(
    #       checkout_url=checkout_url,
    #       product_name=items_summary,
    #       amount=f"${total}" if total else "",
    #   )
    #   return await send_email(
    #       to=to,
    #       subject="Your SureShot Books Payment Link",
    #       html=html,
    #       api_key=resend_api_key,
    #       from_email=from_email,
    #   )
    raise NotImplementedError(
        "_email_real() is not yet implemented. "
        "Keep USE_REAL_EMAIL=False until this is ready."
    )


async def _dispatch_email(
    to: str,
    checkout_url: str,
    items_summary: str,
    total: Optional[str],
    resend_api_key: str = "",
    from_email: str = "",
) -> tuple[bool, EmailMode]:
    """
    Route email to stub or real Resend based on USE_REAL_EMAIL flag.

    Returns (email_sent: bool, mode: EmailMode) so the caller can
    record which path ran without inspecting the flag directly.

    Fallback chain when USE_REAL_EMAIL = True:
        _email_real()
            ↓ NotImplementedError  →  _email_stub() + warning
            ↓ any other exception  →  _email_stub() + error log
    """
    if USE_REAL_EMAIL:
        try:
            sent = await _email_real(
                to=to,
                checkout_url=checkout_url,
                items_summary=items_summary,
                total=total,
                resend_api_key=resend_api_key,
                from_email=from_email,
            )
            return sent, "resend"
        except NotImplementedError:
            logger.warning(
                "_email_real() not implemented — falling back to stub (USE_REAL_EMAIL=True ignored)"
            )
        except Exception as exc:
            logger.error(
                "_email_real() failed: %s — falling back to stub", exc, exc_info=True
            )

    sent = await _email_stub(to, checkout_url, items_summary, total)
    return sent, "stub"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 7 — SHOPIFY API PLACEHOLDER  (disabled — interface contract only)
#
# Activated when USE_REAL_SHOPIFY = True and Shopify credentials are present.
# Currently raises NotImplementedError → falls back to MockPaymentLinkGenerator.
#
# Activation steps:
#   1. Set USE_REAL_SHOPIFY = True
#   2. Implement ShopifyDraftOrderClient.create_order() using common/shopify.py
#   3. The email layer remains independent — handled separately by _dispatch_email()
# ─────────────────────────────────────────────────────────────────────────────


class ShopifyDraftOrderClient:
    """
    Interface contract for the real Shopify Admin draft-order API.

    NOT YET IMPLEMENTED.  Raises NotImplementedError → _resolve_payment_link()
    catches it and falls back to MockPaymentLinkGenerator.
    """

    def __init__(self, domain: str, access_token: str) -> None:
        self._domain = domain
        self._access_token = access_token

    def create_order(self, req: SendPaymentLinkRequest) -> SendPaymentLinkData:
        # TODO: implement when Shopify connection is approved
        #
        #   from ..common.shopify import get_shopify_client
        #   client = get_shopify_client(self._domain, self._access_token)
        #   raw = await client.create_draft_order(
        #       email=req.email,
        #       items=[{"variant_id": i.variant_id, "quantity": i.quantity} for i in req.items],
        #       customer_phone=req.customer_phone,
        #       note=req.note or f"Voice order",
        #   )
        #   return _map_shopify_draft_order(raw, req.email)
        raise NotImplementedError(
            "ShopifyDraftOrderClient.create_order() is not yet implemented. "
            "Keep USE_REAL_SHOPIFY=False until this is ready."
        )


def _map_shopify_draft_order(
    raw: dict[str, Any],
    email_sent_to: str,
) -> SendPaymentLinkData:
    """
    Map raw Shopify draft_order API response to SendPaymentLinkData.

    NOT YET ACTIVE — called only by ShopifyDraftOrderClient.create_order().
    Kept here so the mapping is visible and reviewable during architecture phase.
    """
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
        email_sent=False,           # populated by _dispatch_email()
        email_sent_to=email_sent_to,
        email_mode="stub",          # updated by _dispatch_email()
        order_mode="shopify",
        items_summary=items_summary,
        total_estimate=raw.get("total_price"),
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 8 — Resolver  (two-step: draft order → email dispatch)
#
# Step 1 and step 2 are fully independent.
# Changing USE_REAL_SHOPIFY does not affect email.
# Changing USE_REAL_EMAIL does not affect order creation.
# ─────────────────────────────────────────────────────────────────────────────


async def _create_draft_order(
    req: SendPaymentLinkRequest,
    shopify_domain: Optional[str],
    shopify_access_token: Optional[str],
) -> SendPaymentLinkData:
    """
    Step 1: create the draft order via mock or real Shopify.
    Returns SendPaymentLinkData with email_sent=False.
    """
    use_real = USE_REAL_SHOPIFY and bool(shopify_domain and shopify_access_token)

    if use_real:
        try:
            client = ShopifyDraftOrderClient(
                shopify_domain,         # type: ignore[arg-type]
                shopify_access_token,   # type: ignore[arg-type]
            )
            return client.create_order(req)
        except NotImplementedError:
            logger.warning(
                "ShopifyDraftOrderClient not implemented — falling back to MockPaymentLinkGenerator"
            )
        except Exception as exc:
            logger.error(
                "ShopifyDraftOrderClient.create_order() failed: %s — falling back to mock",
                exc,
                exc_info=True,
            )

    logger.debug("send_payment_link: draft order via MockPaymentLinkGenerator")
    return MockPaymentLinkGenerator.create_order(req)


async def _resolve_payment_link(
    req: SendPaymentLinkRequest,
    shopify_domain: Optional[str],
    shopify_access_token: Optional[str],
    resend_api_key: str = "",
    from_email: str = "",
) -> SendPaymentLinkData:
    """
    Orchestrate both steps and return a fully-populated SendPaymentLinkData.

    The two steps run sequentially (email needs the checkout_url from step 1)
    but are otherwise entirely independent.
    """
    # Step 1 — draft order
    order = await _create_draft_order(req, shopify_domain, shopify_access_token)

    # Step 2 — email dispatch
    email_sent, email_mode = await _dispatch_email(
        to=req.email,
        checkout_url=order.checkout_url,
        items_summary=order.items_summary,
        total=order.total_estimate,
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
                "description": (
                    "Set to true ONLY after the caller confirmed their email. "
                    "Never call with false."
                ),
            },
            "items": {
                "type": "array",
                "description": "Items to include in the order",
                "minItems": 1,
                "items": {
                    "type": "object",
                    "properties": {
                        "variant_id": {
                            "type": "string",
                            "description": "Shopify variant ID",
                        },
                        "quantity": {
                            "type": "integer",
                            "minimum": 1,
                            "description": "Number of units",
                        },
                        "title": {
                            "type": "string",
                            "description": "Product title — included in voice summary",
                        },
                        "price": {
                            "type": "string",
                            "description": "Unit price string e.g. '15.95'",
                        },
                    },
                    "required": ["variant_id", "quantity"],
                },
            },
            "customer_phone": {
                "type": "string",
                "description": "Caller phone — logged only, not transmitted",
            },
            "note": {
                "type": "string",
                "description": "Optional internal note attached to the order",
            },
        },
        "required": ["email", "email_confirmed", "items"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        # ── Gate: email_confirmed must be True ────────────────────────────────
        # Checked before Pydantic so the refusal uses a voice-friendly message.
        if not args.get("email_confirmed", False):
            logger.info(
                "send_payment_link blocked — email not confirmed (session=%s)",
                context.session_id,
            )
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

        # ── Validate input ────────────────────────────────────────────────────
        try:
            req = SendPaymentLinkRequest(**args)
        except Exception as exc:
            logger.warning(
                "send_payment_link validation error: %s (session=%s)",
                exc,
                context.session_id,
            )
            return self.error_result(
                voice_summary=(
                    "I'm missing some information to complete your order. "
                    "Could you confirm the item and your email address?"
                ),
                error=f"Validation failed: {exc}",
            )

        # ── Create draft order + dispatch email ───────────────────────────────
        try:
            result = await _resolve_payment_link(
                req=req,
                shopify_domain=context.agent_config.shopify_domain,
                shopify_access_token=context.agent_config.shopify_access_token,
                resend_api_key=context.agent_config.resend_api_key or "",
                from_email=context.agent_config.from_email,
            )
        except Exception as exc:
            logger.error(
                "send_payment_link unexpected error (session=%s): %s",
                context.session_id,
                exc,
                exc_info=True,
            )
            return self.error_result(
                voice_summary=(
                    "I ran into a problem creating your order. "
                    "Let me connect you with our customer service team."
                ),
                error=f"Payment link creation failed: {exc}",
            )

        # ── Voice summary ─────────────────────────────────────────────────────
        voice_summary = _format_voice_summary(result)

        # ── Structured log ────────────────────────────────────────────────────
        logger.info(
            "send_payment_link: order=%s email_sent=%s email_mode=%s "
            "order_mode=%s items=%r total=%s session=%s",
            result.order_name,
            result.email_sent,
            result.email_mode,
            result.order_mode,
            result.items_summary,
            result.total_estimate,
            context.session_id,
        )

        # ── Build message ─────────────────────────────────────────────────────
        email_label = f"Email dispatched ({result.email_mode})" if result.email_sent else "Email delivery failed"
        message = (
            f"Payment link created ({result.order_mode}). "
            f"{email_label} to {req.email}."
        )

        return ToolResult(
            success=True,
            data={
                "success": True,
                "message": message,
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
