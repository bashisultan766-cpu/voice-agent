"""
DialogueManager — deterministic dialogue intelligence for live voice (v4.3).

Decides clarifications, memory answers, cart confirmations, email spell-back,
and payment final confirmation without calling OpenAI.
"""
from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Any, Optional

from ..cart.session import get_ledger, sync_ledger_to_session
from .states import DialogueDecision, DialogueState

if TYPE_CHECKING:
    from ..pipeline.router import IntentResult
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_VAGUE_CLARIFY = (
    "Sure, I can help with that. Do you have the ISBN, the title, "
    "the author, or just the subject you are looking for?"
)
_ISBN_PROMPT = "Sure. Please read the ISBN slowly."
_TITLE_PROMPT = "Sure. What is the title?"
_ANOTHER_BOOK = "Would you like to add another book, or should I help you with the payment link?"
_ADD_CONFIRM = (
    "Would you like to add this book to your order?"
)
_FRUSTRATED = re.compile(
    r"\b(frustrated|annoyed|angry|upset|ridiculous|useless|"
    r"not working|doesn.?t work|you don.?t understand|what.?s wrong)\b",
    re.IGNORECASE,
)
_ADD_WORDS = re.compile(
    r"\b(yes|add it|add this|i need this|this book|put it in|"
    r"i.?ll take it|sounds good|that.?s the one)\b",
    re.IGNORECASE,
)
_ANOTHER_BOOK_WORDS = re.compile(
    r"\b(another book|one more book|next book|different book|"
    r"add another|more books?)\b",
    re.IGNORECASE,
)
_HAVE_ISBN = re.compile(
    r"\b(i have the isbn|have an isbn|got the isbn|by isbn|using isbn)\b",
    re.IGNORECASE,
)
_HAVE_TITLE = re.compile(
    r"\b(i know the title|have the title|by title|the title is)\b",
    re.IGNORECASE,
)
_SUBJECT_WORDS = re.compile(
    r"\b(about|subject|topic|history|math|science|religion|self.?help)\b",
    re.IGNORECASE,
)


def spell_email_letter_by_letter(email: str) -> str:
    """Return comma-separated letters for voice read-back."""
    if not email:
        return ""
    chars: list[str] = []
    for ch in email.lower():
        if ch.isalnum():
            chars.append(ch)
        elif ch == "@":
            chars.append("at")
        elif ch == ".":
            chars.append("dot")
        elif ch in "-_":
            chars.append(ch)
    return ", ".join(chars)


def _mask_email(email: str) -> str:
    try:
        from ..caller.repository import mask_email
        return mask_email(email)
    except Exception:
        if "@" in email:
            local, domain = email.split("@", 1)
            return local[:1] + "***@" + domain
        return "***"


class DialogueManager:
    """Process one turn and update session dialogue state."""

    @staticmethod
    def get_state(session: "SessionState") -> DialogueState:
        raw = getattr(session, "dialogue", None)
        if isinstance(raw, DialogueState):
            return raw
        if isinstance(raw, dict):
            return DialogueState(**{k: raw.get(k, getattr(DialogueState(), k))
                                    for k in DialogueState.__dataclass_fields__})
        return DialogueState()

    @staticmethod
    def set_state(session: "SessionState", state: DialogueState) -> None:
        session.dialogue = state

    @classmethod
    def process_turn(
        cls,
        session: "SessionState",
        intent_result: "IntentResult",
        caller_text: str,
    ) -> DialogueDecision:
        state = cls.get_state(session)
        intent = intent_result.intent
        entities = intent_result.entities
        decision = DialogueDecision()

        if _FRUSTRATED.search(caller_text):
            state.customer_mood = "frustrated"

        # Sync email memory
        state.last_pending_email = getattr(session, "pending_email", "") or ""
        state.last_confirmed_email = getattr(session, "confirmed_email", "") or ""
        if entities.get("order_number"):
            state.last_order_number = entities["order_number"]
        elif getattr(session, "last_order_number", ""):
            state.last_order_number = session.last_order_number

        pfs = getattr(session, "payment_flow_status", "idle") or "idle"

        # ── Payment final confirmation ─────────────────────────────────────────
        if intent == "confirmation" and entities.get("polarity") == "yes":
            if pfs == "awaiting_send_confirmation":
                decision.execute_payment = True
                decision.override_intent = "payment_execute"
                state.active_flow = "payment_final_confirmation"
                state.expected_next = "payment_sent"
                cls.set_state(session, state)
                return decision
            if state.active_flow == "email_confirmation" or pfs == "awaiting_email_confirmation":
                decision.override_intent = "email_confirmation"
                state.active_flow = "email_confirmation"
                cls.set_state(session, state)
                return decision
            if state.active_flow in ("cart_building", "isbn_collection", "title_collection"):
                ledger = get_ledger(session)
                if ledger.candidate_item:
                    decision.confirm_cart_item = True
                    decision.override_intent = "add_to_cart"
                    cls.set_state(session, state)
                    return decision

        if intent == "confirmation" and entities.get("polarity") == "no":
            if pfs == "awaiting_email_confirmation":
                decision.override_intent = "email_correction"
            elif state.active_flow == "cart_building":
                decision.reject_cart_item = True
                ledger = get_ledger(session)
                ledger.reject_last_candidate()
                sync_ledger_to_session(session, ledger)

        # ── Spell email ────────────────────────────────────────────────────────
        if intent == "spell_email_request":
            decision.spell_email = True
            decision.answer_from_memory = True
            decision.memory_action = "spell_email"
            state.active_flow = "email_collection"
            cls.set_state(session, state)
            return decision

        # ── Cart / ISBN memory questions ───────────────────────────────────────
        if intent in (
            "cart_count_question", "isbn_count_question", "titles_question",
            "cart_review_question", "not_found_question",
        ):
            decision.answer_from_memory = True
            decision.memory_action = intent
            state.active_flow = "cart_review"
            cls.set_state(session, state)
            return decision

        # ── Vague book request ─────────────────────────────────────────────────
        if intent == "vague_book_request":
            decision.should_clarify = True
            decision.clarification_prompt = _VAGUE_CLARIFY
            decision.skip_product_search = True
            state.active_flow = "vague_book_request"
            state.current_topic = "book_purchase"
            state.last_customer_goal = "find_book"
            state.expected_next = "isbn_or_title_or_author"
            state.clarification_count += 1
            cls.set_state(session, state)
            return decision

        if intent == "isbn_collection_start":
            decision.should_clarify = True
            decision.clarification_prompt = _ISBN_PROMPT
            state.active_flow = "isbn_collection"
            state.expected_next = "isbn_digits"
            cls.set_state(session, state)
            return decision

        if intent == "title_collection_start":
            decision.should_clarify = True
            decision.clarification_prompt = _TITLE_PROMPT
            state.active_flow = "title_collection"
            state.expected_next = "book_title"
            cls.set_state(session, state)
            return decision

        # ── Another book ───────────────────────────────────────────────────────
        if intent == "another_book" or _ANOTHER_BOOK_WORDS.search(caller_text):
            decision.should_clarify = True
            decision.clarification_prompt = "Sure. Do you have the next ISBN or title?"
            state.active_flow = "isbn_collection"
            state.current_topic = "book_purchase"
            state.expected_next = "isbn_or_title"
            cls.set_state(session, state)
            return decision

        # ── Add to cart phrasing ───────────────────────────────────────────────
        if intent == "add_to_cart" or (
            intent == "confirmation" and _ADD_WORDS.search(caller_text)
        ):
            decision.confirm_cart_item = True
            state.active_flow = "cart_building"
            cls.set_state(session, state)
            return decision

        # ── Product found flows ────────────────────────────────────────────────
        if intent in ("isbn_search", "book_title_search", "product_search", "author_search"):
            state.active_flow = "cart_building"
            state.current_topic = "book_purchase"
            if entities.get("isbn"):
                ledger = get_ledger(session)
                ledger.record_isbn_provided(entities["isbn"])
                sync_ledger_to_session(session, ledger)

        if intent == "send_payment_link" or intent == "checkout_request":
            state.active_flow = "payment_final_confirmation"
            state.current_topic = "payment"
            if pfs == "idle":
                session.payment_flow_status = "awaiting_email"

        if intent in ("order_lookup", "refund_status", "refund_detail"):
            state.current_topic = intent.replace("_", " ")
            state.active_flow = intent.replace("_status", "_lookup").replace("_detail", "_lookup")
            # Do not clear cart — topic switch only

        if intent == "email_provided":
            state.active_flow = "email_confirmation"
            state.expected_next = "email_yes_no"

        if intent == "email_confirmation":
            state.active_flow = "payment_final_confirmation"
            state.expected_next = "send_confirmation"

        state.turn_memory_summary = cls._build_turn_summary(session, state, intent)
        cls.set_state(session, state)
        decision.log_summary = state.turn_memory_summary
        return decision

    @staticmethod
    def apply_cart_confirmation(session: "SessionState") -> Optional[dict[str, Any]]:
        ledger = get_ledger(session)
        item = ledger.confirm_last_candidate()
        if not item:
            return None
        sync_ledger_to_session(session, ledger)
        state = DialogueManager.get_state(session)
        state.last_confirmed_product = {
            "title": item.title,
            "isbn": item.isbn,
            "price": item.price,
        }
        state.last_agent_question = _ANOTHER_BOOK
        state.expected_next = "another_book_or_payment"
        DialogueManager.set_state(session, state)
        return state.last_confirmed_product

    @staticmethod
    def apply_product_found(
        session: "SessionState",
        *,
        title: str,
        isbn: str = "",
        variant_id: str = "",
        price: str | None = None,
        available: bool = True,
    ) -> None:
        from ..cart.session import add_product_candidate
        item = add_product_candidate(
            session,
            title=title,
            isbn=isbn,
            variant_id=variant_id,
            price=price,
            available=available,
        )
        state = DialogueManager.get_state(session)
        state.last_product_candidate = {
            "title": item.title,
            "isbn": item.isbn,
            "price": item.price,
            "available": item.available,
        }
        state.last_agent_question = _ADD_CONFIRM
        state.active_flow = "cart_building"
        DialogueManager.set_state(session, state)

    @staticmethod
    def apply_product_not_found(session: "SessionState", isbn: str) -> None:
        ledger = get_ledger(session)
        ledger.record_isbn_not_found(isbn)
        sync_ledger_to_session(session, ledger)

    @staticmethod
    def build_spell_email_response(session: "SessionState") -> str:
        confirmed = getattr(session, "confirmed_email", "") or ""
        pending = getattr(session, "pending_email", "") or ""
        fragments = getattr(session, "pending_email_fragments", []) or []

        if confirmed:
            spelled = spell_email_letter_by_letter(confirmed)
            return (
                f"I have {_mask_email(confirmed)}. "
                f"Letter by letter, that is: {spelled}."
            )
        if pending:
            spelled = spell_email_letter_by_letter(pending)
            return (
                f"I heard {_mask_email(pending)}. "
                f"Letter by letter, that is: {spelled}. Is that correct?"
            )
        if fragments:
            return (
                "I have part of your email, but I want to make sure I get it right. "
                "Please spell the full email again slowly."
            )
        return "I do not have an email confirmed yet. Please spell it slowly."

    @staticmethod
    def build_memory_response(session: "SessionState", action: str) -> str:
        ledger = get_ledger(session)
        isbn_hist = getattr(session, "isbn_history", []) or ledger.isbn_provided

        if action == "isbn_count_question":
            n = len(isbn_hist)
            return f"You gave me {n} ISBN number{'s' if n != 1 else ''}."

        if action in ("cart_count_question", "cart_review_question"):
            n = ledger.confirmed_count() or ledger.count()
            if action == "cart_review_question":
                return ledger.cart_summary_text()
            return f"You have {n} book{'s' if n != 1 else ''} selected."

        if action == "titles_question":
            summary = ledger.titles_one_by_one_summary()
            if summary:
                return f"Sure. {summary}"
            if isbn_hist:
                return (
                    f"You gave me {len(isbn_hist)} ISBN number{'s' if len(isbn_hist) != 1 else ''}, "
                    "but I do not have confirmed titles yet."
                )
            return "I do not have any book titles saved yet."

        if action == "not_found_question":
            if ledger.isbn_not_found:
                missing = ", ".join(ledger.isbn_not_found)
                return f"The following ISBN{'s' if len(ledger.isbn_not_found) != 1 else ''} were not found: {missing}."
            return "All the ISBN numbers you gave me matched a title."

        if action == "spell_email":
            return DialogueManager.build_spell_email_response(session)

        return ""

    @staticmethod
    def _build_turn_summary(session: "SessionState", state: DialogueState, intent: str) -> str:
        ledger = get_ledger(session)
        parts = [
            f"flow={state.active_flow}",
            f"intent={intent}",
            f"cart={ledger.confirmed_count()}",
            f"isbns={len(getattr(session, 'isbn_history', []) or [])}",
        ]
        pfs = getattr(session, "payment_flow_status", "idle")
        if pfs != "idle":
            parts.append(f"pay={pfs}")
        return "; ".join(parts)

    @staticmethod
    def safe_log_context(session: "SessionState") -> dict[str, Any]:
        state = DialogueManager.get_state(session)
        ledger = get_ledger(session)
        pending = getattr(session, "pending_email", "")
        confirmed = getattr(session, "confirmed_email", "")
        plan = getattr(session, "response_plan", {}) or {}
        return {
            "active_flow": state.active_flow,
            "expected_next": state.expected_next,
            "cart_count": ledger.count(),
            "confirmed_count": ledger.confirmed_count(),
            "isbn_history_count": len(getattr(session, "isbn_history", []) or []),
            "response_plan_action": plan.get("action", ""),
            "email_pending": bool(pending),
            "email_confirmed": bool(confirmed),
            "email_pending_masked": _mask_email(pending) if pending else "",
            "payment_flow_status": getattr(session, "payment_flow_status", "idle"),
        }
