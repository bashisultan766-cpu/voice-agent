"""
Caller profile and per-call session memory models.

These are stored in Redis (with in-memory fallback) — not in PostgreSQL.
The repository layer provides clean interfaces so a DB backend can be
wired in later via DATABASE_URL without touching this module.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class CallerProfile:
    """
    Persistent profile for a phone number, updated after every call.

    Kept deliberately minimal — never stores raw transcripts or full order data.
    """

    id: str                              # Redis key suffix (normalised phone)
    phone_number: str                    # Raw E.164 from Twilio, e.g. "+15551234567"
    normalized_phone: str                # Digits only, e.g. "15551234567"

    display_name: str = ""               # Caller's name if they gave it
    shopify_customer_id: str = ""        # Resolved Shopify customer GID
    preferred_email: str = ""            # Email they prefer to receive links at

    last_order_id: str = ""              # Shopify GID of their most recent order
    last_order_number: str = ""          # Human-readable "#1234"

    last_seen_at: str = field(default_factory=_now_iso)
    call_count: int = 0
    last_summary: str = ""               # Short summary of last call; never raw PII

    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "phone_number": self.phone_number,
            "normalized_phone": self.normalized_phone,
            "display_name": self.display_name,
            "shopify_customer_id": self.shopify_customer_id,
            "preferred_email": self.preferred_email,
            "last_order_id": self.last_order_id,
            "last_order_number": self.last_order_number,
            "last_seen_at": self.last_seen_at,
            "call_count": self.call_count,
            "last_summary": self.last_summary,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "CallerProfile":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class CallSessionMemory:
    """
    Per-call scratch-pad. Lives for 24 hours in Redis, then expires.

    Stores in-progress context so the agent can reference earlier in the call
    without stuffing everything back into the LLM history.
    """

    call_sid: str
    normalized_phone: str

    caller_name: str = ""
    caller_email: str = ""               # Email provided by caller this call
    verified_email: bool = False         # Confirmed against a Shopify record
    verified_phone: bool = False

    current_intent: str = ""            # e.g. "order_lookup", "product_search"
    selected_items: list[dict] = field(default_factory=list)   # Cart items
    last_order_number: str = ""
    last_product_query: str = ""
    pending_checkout_url: str = ""
    payment_email_sent_to: list[str] = field(default_factory=list)

    conversation_summary: str = ""      # Short summary — no raw PII

    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict:
        return {
            "call_sid": self.call_sid,
            "normalized_phone": self.normalized_phone,
            "caller_name": self.caller_name,
            "caller_email": self.caller_email,
            "verified_email": self.verified_email,
            "verified_phone": self.verified_phone,
            "current_intent": self.current_intent,
            "selected_items": self.selected_items,
            "last_order_number": self.last_order_number,
            "last_product_query": self.last_product_query,
            "pending_checkout_url": self.pending_checkout_url,
            "payment_email_sent_to": self.payment_email_sent_to,
            "conversation_summary": self.conversation_summary,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "CallSessionMemory":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})
