from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from ..dialogue.states import DialogueState


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

    # ── Email confirmation state machine ──────────────────────────────────────
    # pending_email:             normalized candidate awaiting "yes" from caller
    # confirmed_email:           caller confirmed; safe for payment sends
    # email_confidence:          high | medium | low
    # email_rejected_count:      how many times caller said "no" this call
    # rejected_email_candidates: emails the caller explicitly rejected;
    #                            PaymentSafetyGuard blocks these permanently
    pending_email: str = ""
    confirmed_email: str = ""
    email_confidence: str = "low"
    email_rejected_count: int = 0
    rejected_email_candidates: list[str] = field(default_factory=list)

    # ── Multi-turn email fragment accumulator ──────────────────────────────────
    # Customer may say email across 2 turns: "bashisultan766 at gmail" / "dot com"
    pending_email_fragments: list[str] = field(default_factory=list)
    last_email_fragment_turn: int = -1

    # ── Payment flow state machine ────────────────────────────────────────────
    # Tracks where the caller is in the payment funnel so the engine can guide
    # conversation deterministically without relying on the LLM for state.
    #
    # States:
    #   idle                     — no active payment flow
    #   awaiting_email           — need an email address
    #   awaiting_email_confirmation — have pending_email, waiting for yes/no
    #   awaiting_send_confirmation  — email confirmed, waiting for "yes send it"
    #   checkout_created         — draft order created, checkout_url set
    #   payment_sent             — payment email sent successfully
    payment_flow_status: str = "idle"
    payment_block_count: int = 0  # increments on each PaymentSafetyGuard block

    # ── v4.19 LLM payment state machine (explicit flags for llm_tool_runtime) ─
    awaiting_payment_email: bool = False
    pending_payment_email: str = ""
    last_offered_payment_email: str = ""  # survives repeat-email turns until confirm/replace
    payment_email_confirmed: bool = False
    awaiting_payment_email_confirmation: bool = False
    payment_send_in_progress: bool = False
    payment_link_sent: bool = False
    checkout_url: str = ""  # mirrors pending_checkout_url
    checkout_id: str = ""  # mirrors pending_draft_order_id
    email_send_attempted: bool = False
    email_send_success: bool = False
    payment_cart_confirmed: bool = False
    last_payment_attempt_status: str = ""  # success | failed | blocked | pending_confirmation

    # ── v4.27 multi-email payment groups (CartLedger-backed) ───────────────
    payment_destination_groups: list[dict[str, Any]] = field(default_factory=list)
    active_payment_group_index: int = 0
    multi_email_payment_active: bool = False

    # ── Multi-book cart items ──────────────────────────────────────────────────
    # Each item: {title, isbn, variant_id, quantity, price, available, source}
    # Replaces the old flat cart_items list (backward-compatible: same field name)

    # ── Facility context ──────────────────────────────────────────────────────
    last_facility_name: str = ""    # Facility/jail name spoken this call
    last_facility_city: str = ""
    last_facility_state: str = ""

    # ── ISBN collection state (v4.2) ──────────────────────────────────────────
    isbn_buffer: str = ""           # digits collected so far this ISBN
    isbn_buffer_turn: int = -1      # turn when buffer was last updated
    isbn_history: list[str] = field(default_factory=list)  # ISBNs given this call
    isbn_not_found: list[str] = field(default_factory=list)  # ISBNs with no match

    # ── v4.5 product candidate persistence ────────────────────────────────────
    last_product_candidate: dict[str, Any] = field(default_factory=dict)
    last_selected_product: dict[str, Any] = field(default_factory=dict)
    last_selected_title: str = ""
    requested_books: list[str] = field(default_factory=list)

    # ── v4.3 Dialogue intelligence ────────────────────────────────────────────
    dialogue: DialogueState = field(default_factory=DialogueState)

    # ── Response plan (set by ResponsePlanWorker, read by composer) ───────────
    response_plan: dict = field(default_factory=dict)

    # ── v4.3 last dialogue decision (transient per turn) ────────────────────────
    last_dialogue_decision: Any = None

    # ── v4.4 payment flow result (set by PaymentFlowWorker) ───────────────────
    payment_flow_result: dict = field(default_factory=dict)
    payment_scope_count: int = 0
    payment_scope_mode: str = ""
    payment_scope_items: list[str] = field(default_factory=list)

    # ── v4.4 naturalness ──────────────────────────────────────────────────────
    naturalness: Any = None

    # ── v4.6 call memory ──────────────────────────────────────────────────────
    call_memory: Any = None

    # Twilio TwiML welcomeGreeting was spoken at connect (v4.6).
    twiml_greeting_spoken: bool = False

    # ── v4.8 call cutoff / resume ─────────────────────────────────────────────
    # Stores a safe, minimal session snapshot for reconnect-within-window.
    call_resume_snapshot: dict = field(default_factory=dict)
    # UTC epoch seconds when this session ended (set on disconnect).
    call_ended_at: float = 0.0
    # True when a resume was triggered for this reconnect.
    is_resumed_call: bool = False
    # Greeting spoken on resumed call (set by WS setup).
    resume_greeting: str = ""
    # v4.9 resume single-use greeting flags
    resume_greeting_pending: bool = False
    resume_greeting_delivered: bool = False
    resume_context_available: bool = False
    # v4.9 last brain decision (transient per turn)
    last_brain_decision: Any = None
    # v4.8 turn-taking hold flag (digit/email fragment in progress).
    turn_taking_hold: bool = False

    # ── v4.24 multi-book commerce flow (CartLedger-backed) ─────────────────
    commerce_flow_status: str = "idle"
    commerce_pending_candidate: dict[str, Any] = field(default_factory=dict)
    commerce_pending_quantity: int = 0
    commerce_allow_add: bool = False
    last_confirmed_product: dict[str, Any] = field(default_factory=dict)
    awaiting_product_confirmation: bool = False
    # v4.25 — tool progress + interrupt coordination
    voice_interrupted: bool = False
    tool_progress_sent_for_op: str = ""
