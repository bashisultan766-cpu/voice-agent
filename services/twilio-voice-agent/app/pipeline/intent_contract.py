"""Intent execution contract (v4.10).

Every brain final_intent must map to a deterministic executor — never no-op.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

from ..catalog.query_specificity import is_generic_product_query, score_product_query_specificity

logger = logging.getLogger(__name__)

EXEC_SMALL_TALK = "SmallTalkWorker"
EXEC_STORE_INFO = "StoreInfoWorker"
EXEC_RESPONSE_PLAN = "ResponsePlanWorker"
EXEC_PRODUCT_ISBN = "ProductISBNWorker"
EXEC_PRODUCT_SEARCH = "ProductSearchWorker"
EXEC_PAYMENT = "PaymentFlowWorker"
EXEC_CART_MEMORY = "CartMemoryWorker"
EXEC_SPELL_EMAIL = "SpellEmailWorker"
EXEC_CONVERSATION = "ConversationMemoryWorker"
EXEC_FALLBACK = "unknown_safe_clarification"

_SMALL_TALK_INTENTS = frozenset({
    "small_talk", "identity_question", "agent_name_question",
    "company_origin_question", "company_question", "job_question",
    "what_do_you_do", "store_info_question", "keepalive_question",
    "small_talk_keepalive", "frustration_repair",
})

_DETERMINISTIC_PLAN_INTENTS = frozenset({
    "vague_book_request", "isbn_collection_start", "title_collection_start",
    "another_book", "email_provided", "spell_email_request", "ending_thanks",
    "out_of_domain_question", "topic_book_search_offer",
})

_INTENT_EXECUTORS: dict[str, str] = {
    "small_talk": EXEC_SMALL_TALK,
    "identity_question": EXEC_SMALL_TALK,
    "agent_name_question": EXEC_SMALL_TALK,
    "company_origin_question": EXEC_SMALL_TALK,
    "company_question": EXEC_SMALL_TALK,
    "job_question": EXEC_SMALL_TALK,
    "what_do_you_do": EXEC_SMALL_TALK,
    "store_info_question": EXEC_STORE_INFO,
    "keepalive_question": EXEC_SMALL_TALK,
    "small_talk_keepalive": EXEC_SMALL_TALK,
    "frustration_repair": EXEC_SMALL_TALK,
    "vague_book_request": EXEC_RESPONSE_PLAN,
    "isbn_collection_start": EXEC_RESPONSE_PLAN,
    "title_collection_start": EXEC_RESPONSE_PLAN,
    "another_book": EXEC_RESPONSE_PLAN,
    "isbn_search": EXEC_PRODUCT_ISBN,
    "book_title_search": EXEC_PRODUCT_SEARCH,
    "explicit_title_search": EXEC_PRODUCT_SEARCH,
    "product_search": EXEC_PRODUCT_SEARCH,
    "author_search": EXEC_PRODUCT_SEARCH,
    "topic_book_search_offer": EXEC_PRODUCT_SEARCH,
    "send_payment_link": EXEC_PAYMENT,
    "payment_execute": EXEC_PAYMENT,
    "checkout_request": EXEC_PAYMENT,
    "email_provided": EXEC_RESPONSE_PLAN,
    "spell_email_request": EXEC_SPELL_EMAIL,
    "ending_thanks": EXEC_CART_MEMORY,
    "out_of_domain_question": EXEC_RESPONSE_PLAN,
    "unknown": EXEC_FALLBACK,
    "greeting": EXEC_RESPONSE_PLAN,
    "confirmation": EXEC_CONVERSATION,
}


@dataclass(frozen=True)
class ContractDecision:
    intent: str
    executor: str
    allowed: bool
    blocked_reason: str = ""
    resolved_intent: str = ""


def validate_intent_contract(
    intent: str,
    context: Optional[dict[str, Any]] = None,
) -> ContractDecision:
    """
    Validate that intent has a required executor.

    context may include: product_phrase, query, is_isbn, call_sid
    """
    ctx = context or {}
    sid = (ctx.get("call_sid") or "")[:6]
    resolved = intent

    if intent in ("book_title_search", "product_search", "explicit_title_search"):
        query = ctx.get("product_phrase") or ctx.get("query") or ""
        spec = score_product_query_specificity(query)
        if spec.level.value == "generic" or is_generic_product_query(query):
            logger.info(
                "intent_contract_blocked sid=%s intent=%s reason=generic_product_query",
                sid, intent,
            )
            return ContractDecision(
                intent=intent,
                executor=EXEC_RESPONSE_PLAN,
                allowed=False,
                blocked_reason="generic_product_query",
                resolved_intent="vague_book_request",
            )
        if intent == "product_search" and spec.score < 3:
            return ContractDecision(
                intent=intent,
                executor=EXEC_RESPONSE_PLAN,
                allowed=False,
                blocked_reason="low_specificity",
                resolved_intent="vague_book_request",
            )

    executor = _INTENT_EXECUTORS.get(intent)
    if not executor:
        if intent in _SMALL_TALK_INTENTS:
            executor = EXEC_SMALL_TALK
        elif intent in _DETERMINISTIC_PLAN_INTENTS:
            executor = EXEC_RESPONSE_PLAN
        else:
            logger.info(
                "intent_contract_blocked sid=%s intent=%s reason=no_executor",
                sid, intent,
            )
            return ContractDecision(
                intent=intent,
                executor=EXEC_FALLBACK,
                allowed=False,
                blocked_reason="no_executor",
                resolved_intent="unknown",
            )

    logger.info(
        "intent_contract_resolved sid=%s intent=%s executor=%s",
        sid, resolved, executor,
    )
    return ContractDecision(
        intent=intent,
        executor=executor,
        allowed=True,
        resolved_intent=resolved,
    )


def intent_requires_response(intent: str) -> bool:
    """Every handled intent must produce customer-visible text or intentional hold."""
    if intent in ("isbn_collection_start",):
        return True
    contract = validate_intent_contract(intent)
    return contract.executor != "" or contract.resolved_intent == "unknown"
