"""Dialogue state types for v4.3 Professional Dialogue Intelligence."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


ACTIVE_FLOWS = frozenset({
    "idle",
    "greeting",
    "vague_book_request",
    "isbn_collection",
    "title_collection",
    "author_collection",
    "cart_building",
    "cart_review",
    "price_question",
    "email_collection",
    "email_confirmation",
    "payment_final_confirmation",
    "order_lookup",
    "refund_lookup",
    "tracking_lookup",
    "facility_lookup",
    "address_update",
    "cancellation",
    "escalation",
})


@dataclass
class DialogueState:
    """Deterministic conversation memory for one call."""

    current_topic: str = "idle"
    expected_next: str = ""
    active_flow: str = "idle"
    last_customer_goal: str = ""
    last_agent_question: str = ""
    last_product_candidate: dict[str, Any] = field(default_factory=dict)
    last_confirmed_product: dict[str, Any] = field(default_factory=dict)
    last_pending_email: str = ""
    last_confirmed_email: str = ""
    last_order_number: str = ""
    unresolved_question: str = ""
    clarification_count: int = 0
    turn_memory_summary: str = ""
    customer_mood: str = "neutral"  # neutral | frustrated | confused

    def to_dict(self) -> dict[str, Any]:
        return {
            "current_topic": self.current_topic,
            "expected_next": self.expected_next,
            "active_flow": self.active_flow,
            "last_customer_goal": self.last_customer_goal,
            "last_agent_question": self.last_agent_question,
            "last_product_candidate": dict(self.last_product_candidate),
            "last_confirmed_product": dict(self.last_confirmed_product),
            "last_pending_email": self.last_pending_email,
            "last_confirmed_email": self.last_confirmed_email,
            "last_order_number": self.last_order_number,
            "unresolved_question": self.unresolved_question,
            "clarification_count": self.clarification_count,
            "turn_memory_summary": self.turn_memory_summary,
            "customer_mood": self.customer_mood,
        }


@dataclass
class DialogueDecision:
    """Output from DialogueManager.process_turn()."""

    should_clarify: bool = False
    clarification_prompt: str = ""
    override_intent: Optional[str] = None
    skip_product_search: bool = False
    execute_payment: bool = False
    confirm_cart_item: bool = False
    reject_cart_item: bool = False
    spell_email: bool = False
    answer_from_memory: bool = False
    memory_action: str = ""
    expected_next: str = ""
    active_flow: str = ""
    log_summary: str = ""
