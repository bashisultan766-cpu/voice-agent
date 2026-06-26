"""CartMutationWorker — deterministic cart state mutations (v4.5)."""
from __future__ import annotations

import logging
import re
import time
from typing import TYPE_CHECKING, Any, Optional

from ..cart.recovery import attempt_cart_recovery, confirm_pending_candidates
from ..cart.session import get_ledger, sync_ledger_to_session
from ..dialogue.manager import DialogueManager
from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_MULTI_CONFIRM = re.compile(
    r"\b(these books?|both books?|both|all books?|all of them|"
    r"along with|include (?:them|both|all)|these \d+ books?)\b",
    re.IGNORECASE,
)
_COUNT_BOOKS = re.compile(
    r"\b(?:need|want|get|include)\s+(?:the\s+)?"
    r"(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+books?\b",
    re.IGNORECASE,
)
_COUNT_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}


class CartMutationWorker:
    name = "cart_mutation"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        t0 = time.monotonic()
        intent = entities.get("intent", "")
        raw_text = entities.get("raw_text", "")

        if intent == "send_payment_link":
            return await self._recovery_for_payment(session, entities, settings, t0)

        if intent == "quantity_update":
            return self._update_quantity(session, entities, t0)

        if intent in ("cart_count_question",):
            return self._cart_count_answer(session, t0)

        if intent == "another_book":
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"action": "ask_next_book"},
                safe_summary="Sure. Do you have the next ISBN or title?",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        if intent == "multi_book_order":
            if _MULTI_CONFIRM.search(raw_text) or entities.get("confirm_all") == "true":
                return self._confirm_multiple(session, raw_text, entities, t0)
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"action": "multi_book_ack"},
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        if intent in ("add_to_cart", "confirm_product"):
            if entities.get("confirm_all") == "true" or _MULTI_CONFIRM.search(raw_text):
                return self._confirm_multiple(session, raw_text, entities, t0)
            return self._confirm_one(session, t0)

        if intent == "remove_from_cart":
            return self._remove_item(session, entities, t0)

        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={},
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )

    async def _recovery_for_payment(
        self,
        session: "SessionState",
        entities: dict,
        settings,
        t0: float,
    ) -> WorkerResult:
        ledger = get_ledger(session)
        if ledger.confirmed_count() > 0:
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"action": "cart_ok", "cart_count": ledger.confirmed_count()},
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        raw_text = entities.get("raw_text", "")
        result = await attempt_cart_recovery(session, raw_text, settings)
        ledger = get_ledger(session)
        if result.success and ledger.confirmed_count() > 0:
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={
                    "action": "cart_recovered",
                    "cart_count": ledger.confirmed_count(),
                    "not_found": result.not_found,
                },
                safe_summary=(
                    f"Recovered {ledger.confirmed_count()} book(s) for checkout."
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )
        return WorkerResult(
            worker_name=self.name,
            success=False,
            error_code="cart_empty",
            data={"action": "cart_recovery_failed", "reason": result.reason},
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )

    def _confirm_one(self, session: "SessionState", t0: float) -> WorkerResult:
        ledger = get_ledger(session)
        candidate = ledger.eligible_candidate_item
        if not candidate:
            blocked = [
                i for i in ledger.items
                if i.confirmation_status == "candidate" and not i.candidate_guard_allowed
            ]
            if blocked and ledger.confirmed_count() > 0:
                logger.info(
                    "cart_mutation_result action=confirm_last_candidate success=false "
                    "reason=blocked_candidates_only sid=%s",
                    session.call_sid[:6],
                )
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={
                        "action": "cart_already_confirmed",
                        "cart_count": ledger.confirmed_count(),
                    },
                    safe_summary=(
                        "Those books are already in your cart. "
                        "Would you like another book or a payment link?"
                    ),
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="local",
                )
            if ledger.confirmed_count() > 0:
                logger.info(
                    "cart_mutation_result action=confirm_last_candidate success=true reason=already_confirmed cart_count=%d sid=%s",
                    ledger.confirmed_count(),
                    session.call_sid[:6],
                )
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={"action": "cart_already_confirmed", "cart_count": ledger.confirmed_count()},
                    safe_summary=(
                        "That book is already in your cart. "
                        "Would you like another book or a payment link?"
                    ),
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="local",
                )
            logger.info(
                "cart_mutation_result action=confirm_last_candidate success=false reason=no_candidate sid=%s",
                session.call_sid[:6],
            )
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="cart_confirm_failed_no_candidate",
                data={"action": "cart_confirm_failed_no_candidate"},
                safe_summary=(
                    "I don't have a book waiting to add. "
                    "Which ISBN or title would you like?"
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        if candidate.confirmation_status == "confirmed":
            logger.info(
                "cart_mutation_result action=confirm_last_candidate success=true reason=already_confirmed cart_count=%d sid=%s",
                ledger.confirmed_count(),
                session.call_sid[:6],
            )
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"action": "cart_already_confirmed", "cart_count": ledger.confirmed_count()},
                safe_summary=(
                    f"{candidate.title} is already in your cart. "
                    "Would you like another book or a payment link?"
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        if not candidate.variant_id:
            logger.info(
                "cart_mutation_result action=confirm_last_candidate success=false reason=missing_variant sid=%s",
                session.call_sid[:6],
            )
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="cart_confirm_failed_missing_variant",
                data={"action": "cart_confirm_failed_missing_variant"},
                safe_summary=(
                    "I found that book but I'm missing checkout details. "
                    "Could you give me the ISBN again?"
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        from ..catalog.stock_overrides import is_out_of_stock_override
        from ..catalog.availability import availability_response, AVAILABILITY_OUT_OF_STOCK
        if is_out_of_stock_override(candidate.title):
            logger.info(
                "cart_mutation_result action=confirm_blocked reason=out_of_stock_override "
                "title=%s sid=%s",
                candidate.title[:40],
                session.call_sid[:6],
            )
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="out_of_stock",
                data={"action": "out_of_stock_override", "title": candidate.title},
                safe_summary=availability_response(AVAILABILITY_OUT_OF_STOCK),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="override",
            )

        product = DialogueManager.apply_cart_confirmation(session)
        ledger = get_ledger(session)
        logger.info(
            "cart_mutation_result action=confirm_last_candidate success=true cart_count=%d sid=%s",
            ledger.confirmed_count(),
            session.call_sid[:6],
        )
        title = (product or {}).get("title", "the book")
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={
                "action": "cart_item_confirmed",
                "cart_count": ledger.confirmed_count(),
                "confirmed": product,
            },
            safe_summary=(
                f"Added {title}. "
                "Would you like to add another book, or should I help you with the payment link?"
            ),
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )

    def _confirm_multiple(
        self,
        session: "SessionState",
        raw_text: str,
        entities: dict,
        t0: float,
    ) -> WorkerResult:
        ledger = get_ledger(session)
        pending = ledger.eligible_pending_candidates()
        if not pending:
            return self._confirm_one(session, t0)

        count_hint = entities.get("requested_cart_count")
        limit: Optional[int] = int(count_hint) if count_hint and str(count_hint).isdigit() else None
        m = _COUNT_BOOKS.search(raw_text)
        if m:
            val = m.group(1).lower()
            limit = int(val) if val.isdigit() else _COUNT_WORDS.get(val)

        if re.search(r"\bboth\b", raw_text, re.I):
            limit = 2
        m2 = re.search(r"\bthese\s+(\d+|one|two|three|four|five)\s+books?\b", raw_text, re.I)
        if m2:
            val = m2.group(1).lower()
            limit = int(val) if val.isdigit() else _COUNT_WORDS.get(val, limit)

        confirmed_titles: list[str] = []
        confirmed = 0
        for item in pending:
            if limit is not None and confirmed >= limit:
                break
            if not item.variant_id or not item.candidate_guard_allowed:
                continue
            if item.confirmation_status == "candidate":
                item.confirmation_status = "confirmed"
                item.eligible_for_checkout = True
                if not item.selection_origin:
                    item.selection_origin = (
                        "isbn_confirmed" if item.isbn else "title_confirmed"
                    )
                confirmed += 1
                confirmed_titles.append(item.title)

        sync_ledger_to_session(session, ledger)
        state = DialogueManager.get_state(session)
        state.active_flow = "cart_building"
        state.expected_next = "another_book_or_payment"
        DialogueManager.set_state(session, state)

        logger.info(
            "cart_mutation_result action=confirm_multiple success=%s cart_count=%d sid=%s",
            confirmed > 0,
            ledger.confirmed_count(),
            session.call_sid[:6],
        )

        if confirmed == 0:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="cart_confirm_failed_no_candidate",
                data={"action": "cart_confirm_failed_no_candidate"},
                safe_summary="Which ISBN or title should I add?",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={
                "action": "cart_item_confirmed",
                "cart_count": ledger.confirmed_count(),
                "confirmed_count": confirmed,
            },
            safe_summary=(
                f"I've added {ledger.confirmed_count()} book(s) to your order. "
                "Would you like a payment link?"
            ),
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )

    def _update_quantity(
        self,
        session: "SessionState",
        entities: dict,
        t0: float,
    ) -> WorkerResult:
        qty_str = entities.get("quantity", "")
        if not qty_str or not str(qty_str).isdigit():
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_quantity",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )
        qty = int(qty_str)
        ledger = get_ledger(session)
        target = ledger.candidate_item or (ledger.confirmed_items[-1] if ledger.confirmed_items else None)
        if not target:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_item",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )
        key = target.isbn or target.title
        ledger.update_quantity(key, qty)
        sync_ledger_to_session(session, ledger)
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={"action": "quantity_updated", "quantity": qty},
            safe_summary=f"Updated quantity to {qty}.",
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )

    def _cart_count_answer(self, session: "SessionState", t0: float) -> WorkerResult:
        ledger = get_ledger(session)
        n = ledger.confirmed_count() or ledger.count()
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={"action": "cart_count", "cart_count": n},
            safe_summary=f"You have {n} book{'s' if n != 1 else ''} selected.",
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )

    def _remove_item(
        self,
        session: "SessionState",
        entities: dict,
        t0: float,
    ) -> WorkerResult:
        ledger = get_ledger(session)
        candidate = ledger.candidate_item
        if candidate:
            candidate.confirmation_status = "rejected"
            sync_ledger_to_session(session, ledger)
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={"action": "removed"},
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
