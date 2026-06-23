"""Eric Agent Runtime types (v4.11)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


VALID_SUPERVISOR_INTENTS = frozenset({
    "small_talk", "identity", "company_question", "book_search", "isbn_collection",
    "order_lookup", "refund_lookup", "shipping_question", "facility_approval",
    "facility_restriction", "address_update", "cancellation", "payment_link",
    "email_capture", "email_spell", "cart_memory", "call_resume", "out_of_domain",
    "customer_service", "ending", "unknown", "book_topic_allowed", "greeting",
    "vague_book_request", "payment_execute", "frustration_repair",
    "repeat_clarification",
})

VALID_WORKER_CATEGORIES = frozenset({
    "catalog_search", "isbn_lookup", "order_lookup", "shipping_lookup",
    "refund_lookup", "facility_approval", "facility_restriction",
    "address_update", "cancellation", "payment_flow", "email_capture",
    "cart_memory", "escalation", "store_info", "none",
})

VALID_MOODS = frozenset({"normal", "confused", "frustrated", "angry"})
VALID_BOUNDARIES = frozenset({
    "inside_sureshot", "book_topic_allowed", "outside_domain_redirect",
})
VALID_STRATEGIES = frozenset({
    "direct", "ask_one_question", "repair", "confirm", "payment",
    "email_readback", "domain_redirect", "ending",
})


@dataclass
class WorkerRequest:
    worker: str = "none"
    reason: str = ""
    can_run_parallel: bool = True


@dataclass
class SupervisorDecision:
    user_intent: str = "unknown"
    confidence: float = 0.0
    customer_mood: str = "normal"
    domain_boundary: str = "inside_sureshot"
    worker_requests: list[WorkerRequest] = field(default_factory=list)
    facts_needed: list[str] = field(default_factory=list)
    should_answer_now: bool = True
    should_wait_for_more_speech: bool = False
    response_strategy: str = "direct"
    one_question_to_ask: str = ""
    must_not_say: list[str] = field(default_factory=list)
    memory_updates: list[str] = field(default_factory=list)
    response_draft: str = ""
    source: str = "router"
    entities: dict[str, str] = field(default_factory=dict)

    def to_log_dict(self) -> dict[str, Any]:
        workers = [w.worker for w in self.worker_requests if w.worker != "none"]
        return {
            "intent": self.user_intent,
            "confidence": round(self.confidence, 2),
            "workers": workers[:8],
            "mood": self.customer_mood,
            "source": self.source,
        }


@dataclass
class StatePacket:
    cart_count: int = 0
    email_state: str = "none"
    payment_stage: str = "idle"
    order_number: str = ""
    facility_name: str = ""
    active_flow: str = ""
    expected_next: str = ""
    previous_assistant: str = ""
    resume_pending: bool = False
    isbn_count: int = 0

    def to_context(self) -> str:
        parts: list[str] = []
        if self.active_flow and self.active_flow != "idle":
            parts.append(f"Active flow: {self.active_flow}")
        if self.expected_next:
            parts.append(f"Expected next: {self.expected_next}")
        if self.cart_count:
            parts.append(f"Cart books: {self.cart_count}")
        if self.email_state != "none":
            parts.append(f"Email: {self.email_state}")
        if self.payment_stage != "idle":
            parts.append(f"Payment: {self.payment_stage}")
        if self.order_number:
            parts.append(f"Order: {self.order_number}")
        if self.facility_name:
            parts.append(f"Facility: {self.facility_name[:40]}")
        if self.isbn_count:
            parts.append(f"ISBNs given: {self.isbn_count}")
        if self.resume_pending:
            parts.append("Call resume pending")
        return "\n".join(parts)


@dataclass
class RuntimeTurnResult:
    response_text: str = ""
    skip_turn: bool = False
    skip_reason: str = ""
    source: str = "llm"
    supervisor: Optional[SupervisorDecision] = None
