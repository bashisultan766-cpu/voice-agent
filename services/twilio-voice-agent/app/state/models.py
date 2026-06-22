from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class SafeCallerContext:
    """
    Non-sensitive caller context forwarded into the OpenAI agent system prompt.

    Rules enforced here:
    - preferred_email_masked is always the masked form — full email never included.
    - last_summary is a short, human-written snippet — no raw transcripts.
    - last_order_number may be mentioned to offer helpful follow-up, but the LLM
      must still call lookup_order with verification before sharing details.
    - greeted_already signals that the WebSocket layer already sent a personalised
      greeting; the LLM should not repeat it on the first response.
    """

    is_returning_caller: bool = False
    caller_name: str = ""
    call_count: Optional[int] = None       # Total prior calls, from profile
    preferred_email_masked: str = ""       # e.g. "d***n@example.com"
    last_summary: str = ""                 # Short, non-sensitive call summary
    last_order_number: str = ""            # e.g. "#1234" — for follow-up prompts only
    verified_email: bool = False           # True if verified THIS call
    verified_phone: bool = False           # True if verified THIS call
    greeted_already: bool = False          # True if WS greeting was already spoken


@dataclass
class SessionState:
    """Mutable state for one active call session."""

    session_id: str
    call_sid: str
    from_number: str
    to_number: str

    # Resolved at setup time from custom parameters or DB lookup.
    agent_id: str = ""
    store_domain: str = ""

    # Conversation history in OpenAI message format.
    # Trimmed automatically to keep context short.
    history: list[dict[str, Any]] = field(default_factory=list)

    # Total turns completed this call.
    turn_count: int = 0

    # Custom parameters forwarded from TwiML <Parameter> tags.
    custom_params: dict[str, str] = field(default_factory=dict)

    # ── Caller identity ──────────────────────────────────────────────────────
    caller_name: str = ""              # Name given by caller or from profile
    caller_email: str = ""            # Email provided during this call
    verified_email: bool = False      # Confirmed against a Shopify order record
    verified_phone: bool = False      # Confirmed against a Shopify order record
    is_returning_caller: bool = False # True when profile existed at call start
    caller_profile_loaded: bool = False

    # Populated from CallerProfile after profile load — safe to include in context.
    caller_call_count: int = 0        # Number of prior calls
    caller_last_summary: str = ""     # Short non-sensitive summary from last call

    # ── Active cart / checkout ───────────────────────────────────────────────
    # [{variant_id, quantity, title, price}]
    cart_items: list[dict[str, Any]] = field(default_factory=list)

    # Set after create_checkout_link — prevents duplicate draft orders.
    pending_checkout_url: str = ""
    pending_draft_order_id: str = ""

    # Tracks payment link emails sent this call — prevents duplicates.
    payment_email_sent_to: list[str] = field(default_factory=list)

    # ── Last search context ──────────────────────────────────────────────────
    last_product_id: str = ""
    last_product_title: str = ""
    last_product_variant_id: str = ""
    last_order_number: str = ""

    # ── Pipeline prefetch cache ───────────────────────────────────────────────
    # Keyed by prefetch_key(tool_name, args) — populated by RealtimePipelineEngine.
    # registry.dispatch checks this before making live Shopify calls.
    prefetch_cache: dict[str, str] = field(default_factory=dict)
