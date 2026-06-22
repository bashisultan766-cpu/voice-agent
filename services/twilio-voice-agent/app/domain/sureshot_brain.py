"""SureShot Books domain brain — deterministic context for composer (v4.6)."""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from .faq import match_faq
from .policies import (
    is_medical_request,
    is_political_debate,
    is_politics_topic,
    is_sports_topic,
    medical_boundary_message,
    politics_redirect_message,
    sports_redirect_message,
)

if TYPE_CHECKING:
    from ..state.models import SessionState

_DOMAIN_SUMMARY = (
    "SureShot Books helps customers buy books, newspapers, novels, and reading materials "
    "from our Shopify catalog. Many customers order approved reading materials for inmates "
    "and correctional facilities. You help with ISBN/title search, carts, payment links, "
    "orders, tracking, refunds, shipping, facility questions, address updates, "
    "cancellations, and escalation. Stay in this domain. Never invent catalog, prices, "
    "refunds, or facility rules — use worker data only."
)


def build_domain_excerpt(
    session: "SessionState",
    caller_text: str,
    intent: str = "",
) -> str:
    """
    Compact domain context injected into the composer user message.
    """
    parts = [_DOMAIN_SUMMARY]

    faq_answer = match_faq(caller_text)
    if faq_answer:
        parts.append(f"Domain FAQ hint: {faq_answer}")

    if is_political_debate(caller_text):
        parts.append(f"Policy: do not debate politics. Say: {politics_redirect_message()}")
    elif is_politics_topic(caller_text) and intent not in (
        "product_search", "book_title_search", "author_search", "isbn_search",
    ):
        parts.append(f"Policy: redirect to book search. Say: {politics_redirect_message()}")

    if is_sports_topic(caller_text) and intent not in (
        "product_search", "book_title_search", "author_search", "isbn_search",
    ):
        parts.append(f"Policy: redirect to book search. Say: {sports_redirect_message()}")

    if is_medical_request(caller_text):
        parts.append(f"Policy: {medical_boundary_message()}")

    ledger_count = 0
    try:
        from ..cart.session import get_ledger
        ledger_count = get_ledger(session).confirmed_count()
    except Exception:
        pass

    isbn_n = len(getattr(session, "isbn_history", []) or [])
    if ledger_count and intent in ("isbn_collection_start", "isbn_search"):
        parts.append(
            "Cart already has books — do not ask for ISBN again unless customer wants another book."
        )
    if isbn_n and intent == "isbn_collection_start":
        parts.append(
            f"Customer already gave {isbn_n} ISBN(s) this call — summarize known ISBNs/cart."
        )

    return "\n".join(parts)


def domain_answer_for_intent(intent: str, caller_text: str) -> Optional[str]:
    """Direct FAQ answer without Shopify when intent is store_info or domain FAQ."""
    if intent == "store_info_question":
        faq = match_faq(caller_text) or match_faq("what is your store name")
        return faq
    return match_faq(caller_text)
