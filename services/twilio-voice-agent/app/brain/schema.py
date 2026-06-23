"""EricDialogueBrain JSON schema types (v4.9)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

VALID_INTENTS = frozenset({
    "small_talk", "identity_question", "store_info_question", "vague_book_request",
    "isbn_collection_start", "isbn_search", "email_provided", "spell_email_request",
    "send_payment_link", "payment_execute", "order_lookup", "shipping_question",
    "facility_approval_question", "address_update", "cancellation_request",
    "book_not_listed", "backorder_question", "memory_summary_question", "ending_thanks",
    "frustration_repair", "unknown",
    # v4.8 carry-over intents brain may emit
    "greeting", "confirmation", "add_to_cart", "another_book", "email_confirmation",
    "email_correction", "isbn_collection_start", "keepalive_question",
    "agent_name_question", "company_origin_question", "small_talk_keepalive",
    "checkout_request", "product_search", "confirm_product",
    # v4.10
    "job_question", "what_do_you_do", "company_question",
    "out_of_domain_question", "topic_book_search_offer",
    "explicit_title_search", "book_title_search", "author_search",
})

VALID_MOODS = frozenset({"normal", "confused", "frustrated", "angry"})
VALID_STYLES = frozenset({
    "short", "repair", "email_readback", "payment", "closing", "domain_answer",
})


@dataclass
class BrainDecision:
    intent: str = "unknown"
    confidence: float = 0.0
    customer_mood: str = "normal"
    task_required: bool = False
    worker_plan: list[str] = field(default_factory=list)
    response_style: str = "short"
    response_goal: str = ""
    ask_one_question: str = ""
    should_hold_for_more_speech: bool = False
    safety_note: str = ""
    source: str = "router"  # router | fast_path | llm | fallback

    def to_log_dict(self) -> dict[str, Any]:
        return {
            "intent": self.intent,
            "confidence": round(self.confidence, 2),
            "mood": self.customer_mood,
            "worker_plan": self.worker_plan[:6],
            "source": self.source,
        }


def parse_brain_json(raw: dict) -> BrainDecision:
    """Parse and validate LLM JSON output into BrainDecision."""
    intent = str(raw.get("intent", "unknown")).strip()
    if intent not in VALID_INTENTS:
        intent = "unknown"

    mood = str(raw.get("customer_mood", "normal")).strip()
    if mood not in VALID_MOODS:
        mood = "normal"

    style = str(raw.get("response_style", "short")).strip()
    if style not in VALID_STYLES:
        style = "short"

    workers = raw.get("worker_plan") or []
    if not isinstance(workers, list):
        workers = []
    workers = [str(w) for w in workers if w][:8]

    conf = raw.get("confidence", 0.0)
    try:
        conf = float(conf)
    except (TypeError, ValueError):
        conf = 0.0
    conf = max(0.0, min(1.0, conf))

    return BrainDecision(
        intent=intent,
        confidence=conf,
        customer_mood=mood,
        task_required=bool(raw.get("task_required", False)),
        worker_plan=workers,
        response_style=style,
        response_goal=str(raw.get("response_goal", ""))[:200],
        ask_one_question=str(raw.get("ask_one_question", ""))[:200],
        should_hold_for_more_speech=bool(raw.get("should_hold_for_more_speech", False)),
        safety_note=str(raw.get("safety_note", ""))[:200],
        source="llm",
    )
