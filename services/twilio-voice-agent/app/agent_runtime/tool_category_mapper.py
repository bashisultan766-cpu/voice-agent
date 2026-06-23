"""Map MainLLMAgent tool categories to worker intents (v4.14.4)."""
from __future__ import annotations

from dataclasses import dataclass, field

from ..workers.orchestrator import _INTENT_WORKERS

READ_ONLY_CATEGORIES = frozenset({
    "catalog_search", "isbn_lookup", "order_lookup", "refund_lookup",
    "shipping_lookup", "facility_approval", "facility_restriction",
    "cart_memory", "store_info",
})

MUTATING_CATEGORIES = frozenset({
    "cart_mutation", "payment_flow", "email_capture", "escalation",
    "address_update", "cancellation",
})

_CATEGORY_TO_WORKER_INTENT: dict[str, str] = {
    "catalog_search": "product_search",
    "isbn_lookup": "isbn_search",
    "order_lookup": "order_lookup",
    "refund_lookup": "refund_detail",
    "shipping_lookup": "shipping_question",
    "facility_approval": "facility_approval",
    "facility_restriction": "facility_restriction",
    "store_info": "store_info_question",
    "cart_memory": "memory_summary_question",
    "address_update": "address_update",
    "cancellation": "cancellation_request",
    "email_capture": "email_provided",
    "payment_flow": "send_payment_link",
    "escalation": "escalation",
    "cart_mutation": "add_to_cart",
}


@dataclass
class WorkerIntentPlan:
    category: str
    worker_intent: str
    worker_names: list[str] = field(default_factory=list)
    mutating: bool = False


def _resolve_catalog_intent(decision: dict | None, entities: dict) -> str:
    intent = str((decision or {}).get("intent") or "")
    categories = list((decision or {}).get("tool_categories") or [])
    product_kind = (entities.get("product_kind") or "").lower()

    if intent in (
        "newspaper_search", "magazine_search", "subscription_search",
        "catalog_product_search", "publication_search",
    ):
        return "catalog_product_search"
    if product_kind in ("newspaper", "magazine", "subscription", "publication"):
        return "catalog_product_search"
    if intent == "book_title_search":
        return "book_title_search"
    if entities.get("author"):
        return "author_search"
    if entities.get("isbn") and "isbn_lookup" in categories:
        return "product_search"
    if entities.get("isbn"):
        return "isbn_search"
    if entities.get("title") or entities.get("product_phrase"):
        phrase = (entities.get("title") or entities.get("product_phrase") or "").lower()
        if product_kind in ("newspaper", "magazine", "subscription"):
            return "catalog_product_search"
        if phrase and len(phrase.split()) >= 2:
            return "book_title_search"
    return "product_search"


def _resolve_cart_mutation_intent(entities: dict) -> str:
    action = (entities.get("cart_action") or "").lower()
    if action == "remove":
        return "remove_from_cart"
    if action == "count":
        return "cart_count_question"
    if action == "add":
        return "add_to_cart"
    return "add_to_cart"


def _resolve_refund_intent(entities: dict) -> str:
    if entities.get("order_number") or entities.get("email") or entities.get("phone"):
        return "refund_detail"
    return "refund_status"


def _resolve_email_intent(entities: dict) -> str:
    if entities.get("email"):
        return "email_provided"
    return "spell_email_request"


def map_tool_categories_to_worker_intents(
    decision: dict,
    entities: dict,
) -> list[WorkerIntentPlan]:
    """Map business tool categories to validated worker intent plans."""
    categories = list(decision.get("tool_categories") or [])
    plans: list[WorkerIntentPlan] = []

    for category in categories:
        if category == "catalog_search":
            worker_intent = _resolve_catalog_intent(decision, entities)
        elif category == "cart_mutation":
            worker_intent = _resolve_cart_mutation_intent(entities)
        elif category == "refund_lookup":
            worker_intent = _resolve_refund_intent(entities)
        elif category == "email_capture":
            worker_intent = _resolve_email_intent(entities)
        else:
            worker_intent = _CATEGORY_TO_WORKER_INTENT.get(category, category)

        worker_names = list(_INTENT_WORKERS.get(worker_intent, []))
        if not worker_names and worker_intent in _INTENT_WORKERS:
            worker_names = list(_INTENT_WORKERS[worker_intent])

        plans.append(WorkerIntentPlan(
            category=category,
            worker_intent=worker_intent,
            worker_names=worker_names,
            mutating=category in MUTATING_CATEGORIES,
        ))

    return plans


def assert_all_mapped_worker_intents_exist() -> None:
    """Validate every category maps to a known worker intent."""
    sample_entities = {
        "isbn": "9780441172719",
        "product_phrase": "Dune",
        "title": "Dune",
        "author": "Frank Herbert",
        "cart_action": "add",
        "email": "test@example.com",
        "order_number": "1234",
    }
    for category in _CATEGORY_TO_WORKER_INTENT:
        decision = {"tool_categories": [category], "intent": category}
        if category == "catalog_search":
            decision["intent"] = "book_title_search"
        plans = map_tool_categories_to_worker_intents(decision, sample_entities)
        assert plans, f"No plan for category {category}"
        for plan in plans:
            assert plan.worker_intent in _INTENT_WORKERS, (
                f"Invalid worker intent {plan.worker_intent!r} for category {category!r}"
            )
            assert plan.worker_names, (
                f"No workers for intent {plan.worker_intent!r} (category {category!r})"
            )
