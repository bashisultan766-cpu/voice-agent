"""Deterministic cart recovery from ISBN history (v4.5)."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

from .candidate import extract_variant_from_shopify_result, save_product_candidate, save_product_not_found
from .session import get_ledger, sync_ledger_to_session

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_RECOVERY_PHRASES = re.compile(
    r"\b("
    r"these books?|both books?|all books?|all of them|"
    r"i already gave you|already gave you|gave you the isbn|"
    r"send (?:me )?(?:the )?payment link|payment link|"
    r"\d+\s+books?"
    r")\b",
    re.IGNORECASE,
)
_COUNT_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}


@dataclass
class CartRecoveryResult:
    success: bool = False
    reason: str = ""
    cart_count: int = 0
    confirmed_count: int = 0
    not_found: list[str] = field(default_factory=list)
    recovered: int = 0


def user_implies_recovery(raw_text: str) -> bool:
    return bool(_RECOVERY_PHRASES.search(raw_text or ""))


def _parse_requested_count(raw_text: str) -> Optional[int]:
    m = re.search(r"\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+books?\b", raw_text, re.I)
    if not m:
        return None
    val = m.group(1).lower()
    return int(val) if val.isdigit() else _COUNT_WORDS.get(val)


def confirm_pending_candidates(
    session: "SessionState",
    raw_text: str = "",
) -> CartRecoveryResult:
    """Promote pending candidates to confirmed when user phrase implies selection."""
    ledger = get_ledger(session)
    pending = ledger.eligible_pending_candidates()
    if not pending and not user_implies_recovery(raw_text):
        return CartRecoveryResult(reason="no_pending")

    count_hint = _parse_requested_count(raw_text)
    if count_hint and count_hint < len(pending):
        pending = pending[:count_hint]

    if "both" in (raw_text or "").lower() and len(pending) >= 2:
        pending = pending[:2]

    confirmed = 0
    for item in pending:
        if item.confirmation_status == "candidate" and item.variant_id:
            item.confirmation_status = "confirmed"
            item.eligible_for_checkout = True
            if not item.selection_origin:
                item.selection_origin = (
                    "isbn_confirmed" if item.isbn else "title_confirmed"
                )
            confirmed += 1

    sync_ledger_to_session(session, ledger)
    result = CartRecoveryResult(
        success=confirmed > 0 or ledger.confirmed_count() > 0,
        recovered=confirmed,
        cart_count=ledger.count(),
        confirmed_count=ledger.confirmed_count(),
    )
    if confirmed:
        result.reason = "confirmed_pending"
    return result


async def rehydrate_from_isbn_history(
    session: "SessionState",
    settings,
) -> CartRecoveryResult:
    """Re-query cache/Shopify for ISBNs in history when cart is empty."""
    ledger = get_ledger(session)
    isbns = list(getattr(session, "isbn_history", []) or ledger.isbn_provided)
    if not isbns:
        return CartRecoveryResult(reason="no_isbn_history")

    logger.info(
        "cart_recovery_attempt isbn_count=%d candidate_count=%d sid=%s",
        len(isbns),
        len([i for i in ledger.items if i.confirmation_status == "candidate"]),
        session.call_sid[:6],
    )

    from ..sync.repositories import ProductCache
    import json
    from ..tools.shopify_tools import search_products

    cache = ProductCache()
    recovered = 0
    not_found: list[str] = []

    for isbn in isbns:
        existing = next(
            (i for i in ledger.items
             if i.isbn == isbn and i.confirmation_status in ("candidate", "confirmed")),
            None,
        )
        if existing and existing.variant_id:
            if existing.confirmation_status == "candidate":
                existing.confirmation_status = "confirmed"
                recovered += 1
            continue

        product = await cache.get_by_isbn(isbn)
        if product and product.variant_id:
            save_product_candidate(
                session,
                title=product.title,
                isbn=isbn,
                product_id=getattr(product, "product_id", "") or "",
                variant_id=product.variant_id,
                price=product.price,
                available=product.available,
                source="isbn_search",
            )
            ledger = get_ledger(session)
            item = ledger.candidate_item
            if item and item.variant_id:
                item.confirmation_status = "confirmed"
                item.eligible_for_checkout = True
                recovered += 1
            sync_ledger_to_session(session, ledger)
            continue

        try:
            result_json = await search_products(isbn)
            result = json.loads(result_json)
            results = result.get("results") or []
            if not results:
                save_product_not_found(session, isbn)
                not_found.append(isbn)
                continue
            top = results[0]
            product_id, variant_id = extract_variant_from_shopify_result(top)
            if not variant_id:
                not_found.append(isbn)
                continue
            save_product_candidate(
                session,
                title=top.get("title", ""),
                isbn=isbn,
                product_id=product_id,
                variant_id=variant_id,
                price=str(top.get("price")) if top.get("price") else None,
                available=bool(top.get("available", True)),
                source="isbn_search",
            )
            ledger = get_ledger(session)
            item = ledger.candidate_item
            if item:
                item.confirmation_status = "confirmed"
                item.eligible_for_checkout = True
                recovered += 1
            sync_ledger_to_session(session, ledger)
        except Exception:
            logger.exception("cart_recovery isbn lookup failed isbn=%s", isbn)
            not_found.append(isbn)

    ledger = get_ledger(session)
    sync_ledger_to_session(session, ledger)
    result = CartRecoveryResult(
        success=ledger.confirmed_count() > 0,
        recovered=recovered,
        cart_count=ledger.count(),
        confirmed_count=ledger.confirmed_count(),
        not_found=not_found,
        reason="rehydrated" if recovered else "nothing_found",
    )
    if result.success:
        logger.info(
            "cart_recovery_success cart_count=%d not_found=%d sid=%s",
            result.confirmed_count,
            len(not_found),
            session.call_sid[:6],
        )
    else:
        logger.info(
            "cart_recovery_failed reason=%s sid=%s",
            result.reason,
            session.call_sid[:6],
        )
    return result


async def attempt_cart_recovery(
    session: "SessionState",
    raw_text: str,
    settings,
) -> CartRecoveryResult:
    """Run recovery pipeline when payment needs cart but cart is empty."""
    ledger = get_ledger(session)
    if ledger.confirmed_count() > 0:
        return CartRecoveryResult(
            success=True,
            cart_count=ledger.count(),
            confirmed_count=ledger.confirmed_count(),
            reason="already_confirmed",
        )

    pending = [i for i in ledger.items if i.confirmation_status == "candidate"]
    if pending and user_implies_recovery(raw_text):
        return confirm_pending_candidates(session, raw_text)

    if pending and _parse_requested_count(raw_text):
        return confirm_pending_candidates(session, raw_text)

    isbn_hist = getattr(session, "isbn_history", []) or ledger.isbn_provided
    if isbn_hist and (user_implies_recovery(raw_text) or pending):
        return await rehydrate_from_isbn_history(session, settings)

    if isbn_hist and user_implies_recovery(raw_text):
        return await rehydrate_from_isbn_history(session, settings)

    return CartRecoveryResult(reason="no_recovery_action")
