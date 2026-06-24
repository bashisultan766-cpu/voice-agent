"""
Sales conversation flow (v4.17) — professional ElevenLabs-style bookstore agent.

This is the deterministic sales policy that sits in front of the LLM-first
runtime. It owns the natural buying conversation:

  caller: "I need a book"            -> ask for ISBN / title / author
  caller: <full ISBN>                -> look it up, offer to add or find another
  caller: "I need another one"       -> keep the first book, ask for the next
  caller: "add this" / "this one"    -> commit the current book to the cart
  caller: "what's the price?"        -> answer for the CURRENT book, not generic
  caller: "yes" (confirming all)     -> commit everything, offer the payment link

Tools only fetch facts (an ISBN lookup). The final spoken response is always
produced by the LLM final composer (with a deterministic, state-grounded
fallback), so the reply is natural, short, phone-friendly, and sales-oriented.

ISBN safety:
  * Product lookups run ONLY on a checksum-valid ISBN-10/ISBN-13.
  * Fragments like "9780" / "9781" never trigger a lookup and never become the
    current candidate.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

from . import active_commerce_state as acs
from ..tools.isbn import extract_isbn_candidate, looks_like_isbn_fragment

logger = logging.getLogger(__name__)


# ── Intent patterns ──────────────────────────────────────────────────────────
_PAYMENT_PAT = re.compile(
    r"\b(payment link|send (?:me )?(?:the |a )?link|checkout link|"
    r"send (?:me )?(?:the )?payment|email (?:me )?(?:the )?(?:payment )?link|"
    r"pay now|pay for it|create (?:the )?payment|send the bill)\b",
    re.IGNORECASE,
)
_ADD_AND_ANOTHER_PAT = re.compile(
    r"\b("
    r"add this too|add it too|add that too|"
    r"this one and another|i need this one and another|"
    r"i want this one and another|take this and another|"
    r"this and another|add this and (?:find|get|look up) another"
    r")\b",
    re.IGNORECASE,
)
_ANOTHER_PAT = re.compile(
    r"\b("
    r"another (?:one|book)|i need another|i want another|"
    r"look up another|search another|find another|"
    r"next book|one more book|a different book|"
    r"another isbn|give me another"
    r")\b",
    re.IGNORECASE,
)
_ADD_THIS_PAT = re.compile(
    r"\b("
    r"add this|add it|add that|add the book|"
    r"i need this one|i want this one|i.?ll take (?:this|it|this one)|"
    r"take this one|this one please|yes,?\s*add (?:this|it)|"
    r"add to (?:my )?(?:cart|order)"
    r")\b",
    re.IGNORECASE,
)
_PRICE_PAT = re.compile(
    r"\b("
    r"what.?s the price|what is the price|how much (?:is it|does it cost|is that)|"
    r"the price\??|what does it cost|what.?s it cost|how much\b|tell me the price|"
    r"price of (?:it|this|that|the book)"
    r")\b",
    re.IGNORECASE,
)
_NEED_BOOK_PAT = re.compile(
    r"\b("
    r"i need a book|i want a book|i.?m looking for a book|looking for a book|"
    r"need to order a book|i need book|i would like a book|i.?d like a book|"
    r"can i order a book|i want to (?:buy|order) a book|"
    r"help me find a book|i need to buy a book"
    r")\b",
    re.IGNORECASE,
)
_AFFIRM_PAT = re.compile(
    r"^\s*(yes|yeah|yep|yup|sure|ok|okay|correct|right|please do|go ahead|"
    r"that.?s right|sounds good|absolutely|do it|both|all of them|"
    r"yes please|yeah add them|add them all)\s*[.!]*\s*$",
    re.IGNORECASE,
)
_NEGATE_PAT = re.compile(
    r"^\s*(no|nope|nah|not now|not yet|no thanks|no thank you|cancel|stop)\s*[.!]*\s*$",
    re.IGNORECASE,
)


# ── Result type ──────────────────────────────────────────────────────────────
@dataclass
class SalesTurnResult:
    handled: bool
    response_text: str = ""
    intent: str = ""
    tool_results: dict[str, Any] | None = None


# Lookup signature: async (identifier) -> (found, candidate|None, needs_more, raw)
LookupFn = Callable[[str], Awaitable[tuple[bool, Optional[dict], bool, dict]]]


def classify_sales_turn(text: str, state: acs.ActiveCommerceState) -> str:
    """Classify a caller turn into a sales intent (deterministic)."""
    t = (text or "").strip()
    if not t:
        return "none"

    pending = state.pending_action or ""

    # Explicit payment request — only when the caller actually asks to pay.
    if _PAYMENT_PAT.search(t):
        return "payment_request"

    # A full, checksum-valid ISBN is always a product lookup.
    if extract_isbn_candidate(t):
        return "provide_isbn"

    # A partial ISBN fragment — never a lookup, never a candidate.
    if looks_like_isbn_fragment(t) and _is_mostly_digits(t):
        return "isbn_fragment"

    # Affirmative / negative resolve against the pending sales action.
    if pending and _AFFIRM_PAT.match(t):
        return "confirm"
    if pending and _NEGATE_PAT.match(t):
        return "decline"

    if _ADD_AND_ANOTHER_PAT.search(t):
        return "add_and_another"
    if _ANOTHER_PAT.search(t):
        return "another_book"
    if _ADD_THIS_PAT.search(t):
        return "add_this"
    if _PRICE_PAT.search(t):
        return "price_question"
    if _NEED_BOOK_PAT.search(t):
        return "need_book"

    return "none"


def _is_mostly_digits(text: str) -> bool:
    """True when the utterance is dominated by digits / spoken digit words."""
    digits = sum(c.isdigit() for c in text)
    words = [w for w in re.split(r"\s+", text.strip()) if w]
    digit_words = sum(
        1 for w in words
        if w.strip(".,").isdigit() or w.lower().strip(".,") in {
            "zero", "one", "two", "three", "four", "five",
            "six", "seven", "eight", "nine", "oh",
        }
    )
    if digits >= 4:
        return True
    return bool(words) and digit_words >= max(1, len(words) - 2)


def _price_phrase(candidate: dict[str, Any]) -> str:
    price = (candidate or {}).get("price", "") or ""
    if price and price != "N/A":
        return f"It's {price} and available"
    return "It's available"


class SalesFlow:
    """Deterministic sales policy in front of the LLM-first runtime."""

    def __init__(
        self,
        settings=None,
        *,
        lookup_isbn: Optional[LookupFn] = None,
        lookup_title: Optional[LookupFn] = None,
    ):
        from ..config import get_settings

        self._settings = settings or get_settings()
        self._lookup_isbn = lookup_isbn or _default_lookup_isbn

    async def handle(
        self,
        session,
        caller_text: str,
        send: Callable[[dict], Awaitable[None]],
    ) -> Optional[SalesTurnResult]:
        """
        Try to handle one caller turn as part of the sales conversation.

        Returns a SalesTurnResult when handled, or None to defer to the LLM /
        the rest of the runtime.
        """
        sid = getattr(session, "call_sid", "")
        state = acs.load_active_commerce_state(sid)
        intent = classify_sales_turn(caller_text, state)

        if intent in ("none", "payment_request"):
            return None

        tool_results: dict[str, Any] = {}
        fallback = ""

        if intent == "need_book":
            fallback = "Sure — do you have the ISBN, title, or author?"
            state.pending_action = "awaiting_identifier"

        elif intent == "isbn_fragment":
            # Never save a fragment or run a lookup on it.
            logger.info(
                "sales_isbn_fragment_blocked sid=%s",
                (sid or "")[:6],
            )
            fallback = (
                "That sounds like a partial ISBN. Could you read me the full "
                "ISBN — all thirteen digits?"
            )
            state.pending_action = "awaiting_identifier"

        elif intent == "provide_isbn":
            fallback, tool_results = await self._handle_isbn(session, caller_text, state)

        elif intent == "another_book":
            fallback = self._handle_another_book(session, state)

        elif intent == "add_and_another":
            fallback = self._handle_add_and_another(session, state)

        elif intent == "add_this":
            fallback = self._handle_add_this(session, state)

        elif intent == "price_question":
            handled, fallback = self._handle_price(session, state)
            if not handled:
                return None

        elif intent == "confirm":
            res = self._handle_confirm(session, state)
            if res is None:
                return None  # defer (e.g. confirm a payment send)
            fallback = res

        elif intent == "decline":
            fallback = "No problem. Would you like to look up another book, or is there anything else?"
            state.pending_action = None

        else:
            return None

        acs.save_active_commerce_state(state)

        response = await self._compose(
            session, sid, caller_text, intent, fallback, state, tool_results,
        )

        await _await_send(send, {"type": "text", "token": response, "last": False, "interruptible": True})
        await _await_send(send, {"type": "text", "token": "", "last": True})

        from ..safety.response_sanitizer import log_assistant_response
        from .call_memory_manager import CallMemoryManager
        from .conversation_state_machine import record_safe_response, clear_interrupt

        log_assistant_response(response, call_sid=sid, intent=intent)
        try:
            record_safe_response(sid, response)
            clear_interrupt(sid)
        except Exception:  # noqa: BLE001
            pass
        CallMemoryManager.update_after_turn(session, caller_text, response, intent)

        return SalesTurnResult(
            handled=True,
            response_text=response,
            intent=intent,
            tool_results=tool_results,
        )

    # ── Intent handlers ───────────────────────────────────────────────────
    async def _handle_isbn(
        self, session, caller_text: str, state: acs.ActiveCommerceState
    ) -> tuple[str, dict[str, Any]]:
        from ..conversation.call_memory import record_sales_fact

        isbn = extract_isbn_candidate(caller_text) or ""
        found, candidate, needs_more, raw = await self._lookup_isbn(isbn)
        tool_results = {"SearchBookByISBN": raw}

        if needs_more or not isbn:
            state.pending_action = "awaiting_identifier"
            return (
                "I need the full ISBN to look it up. Could you read me all "
                "thirteen digits?",
                tool_results,
            )

        if not found or not candidate:
            state.pending_action = "awaiting_identifier"
            return (
                "I couldn't find a book with that ISBN. Could you double-check "
                "the number, or give me the title or author?",
                tool_results,
            )

        # Record the found book as the current candidate (durable).
        acs.set_current_candidate(state, candidate)
        record_sales_fact(session, "selected_product", candidate.get("title", ""))
        record_sales_fact(session, "isbn", isbn)

        title = candidate.get("title", "the book")
        price_phrase = _price_phrase(candidate)
        prior = state.cart_count() + len(state.selected_candidates)

        if prior > 0:
            state.pending_action = "confirm_add_all"
            total = prior + 1
            if total == 2:
                ask = "Do you want both books added to your order?"
            else:
                ask = f"Do you want all {total} books added to your order?"
            return f"I found {title}. {price_phrase}. {ask}", tool_results

        state.pending_action = "add_or_another"
        return (
            f"I found {title}. {price_phrase}. Would you like to add this one, "
            "or should I look up another book?",
            tool_results,
        )

    def _handle_another_book(self, session, state: acs.ActiveCommerceState) -> str:
        from ..conversation.call_memory import record_sales_fact

        # Keep the first book — commit the current candidate to the cart so it
        # is never lost when the caller moves on to the next book.
        if state.has_current_candidate():
            committed = acs.commit_current_to_cart(state)
            if committed:
                record_sales_fact(session, "cart_line", committed.get("title", ""))
        record_sales_fact(session, "another_book")
        state.pending_action = "awaiting_identifier"
        return "Of course — give me the next ISBN or title."

    def _handle_add_and_another(self, session, state: acs.ActiveCommerceState) -> str:
        from ..conversation.call_memory import record_sales_fact

        committed = acs.commit_current_to_cart(state)
        state.pending_action = "awaiting_identifier"
        if committed:
            record_sales_fact(session, "cart_line", committed.get("title", ""))
            return (
                f"Got it — I've added {committed.get('title', 'that book')}. "
                "Please give me the next ISBN or title."
            )
        return "Sure — give me the next ISBN or title."

    def _handle_add_this(self, session, state: acs.ActiveCommerceState) -> str:
        from ..conversation.call_memory import record_sales_fact

        if state.has_current_candidate():
            title = state.current_title()
            acs.commit_current_to_cart(state)
            record_sales_fact(session, "cart_line", title)
            state.pending_action = "another_or_payment"
            return (
                f"Done — I've added {title} to your order. Would you like "
                "another book, or should I send the payment link?"
            )
        if state.cart_count() > 0 or state.selected_candidates:
            state.pending_action = "another_or_payment"
            return (
                "I've got that. Would you like another book, or should I send "
                "the payment link?"
            )
        state.pending_action = "awaiting_identifier"
        return "Sure — which book would you like? You can give me the ISBN, title, or author."

    def _handle_price(self, session, state: acs.ActiveCommerceState) -> tuple[bool, str]:
        from ..conversation.call_memory import record_sales_fact

        target = state.current_candidate
        if not target and state.cart_lines:
            target = state.cart_lines[-1]
        if not target and state.selected_candidates:
            target = state.selected_candidates[-1]

        if not target:
            return False, ""  # no commerce context — defer to LLM/business resolver

        title = target.get("title", "that book")
        price = target.get("price", "") or ""
        record_sales_fact(session, "price_target", title)
        if price and price != "N/A":
            return True, (
                f"The price for {title} is {price}. Would you like me to add it "
                "to your order?"
            )
        return True, (
            f"I found {title}, but I don't have a confirmed price from the store "
            "right now. Let me check that for you."
        )

    def _handle_confirm(
        self, session, state: acs.ActiveCommerceState
    ) -> Optional[str]:
        from ..conversation.call_memory import record_sales_fact

        pending = state.pending_action or ""

        if pending == "confirm_add_all":
            n = acs.commit_all_to_cart(state)
            record_sales_fact(session, "cart_line", f"{n} books confirmed")
            state.pending_action = "send_payment"
            if n == 2:
                return "Great, I've got both books. Would you like me to send the payment link now?"
            return f"Great, I've got all {n} books. Would you like me to send the payment link now?"

        if pending == "add_or_another":
            if state.has_current_candidate():
                title = state.current_title()
                acs.commit_current_to_cart(state)
                record_sales_fact(session, "cart_line", title)
                state.pending_action = "another_or_payment"
                return (
                    f"Done — I've added {title} to your order. Would you like "
                    "another book, or should I send the payment link?"
                )

        if pending == "another_or_payment":
            state.pending_action = "send_payment"
            return "Great. Would you like me to send the payment link now?"

        # "yes" to a payment-send offer — let the real payment flow handle it.
        if pending == "send_payment":
            return None

        return None

    # ── Final response composition ─────────────────────────────────────────
    async def _compose(
        self,
        session,
        sid: str,
        caller_text: str,
        intent: str,
        fallback: str,
        state: acs.ActiveCommerceState,
        tool_results: dict[str, Any],
    ) -> str:
        from .llm_final_composer import compose_final_response

        memory_facts: list[str] = []
        try:
            from ..conversation.call_memory import get_call_memory

            memory_facts = list(get_call_memory(session).important_facts)
        except Exception:  # noqa: BLE001
            pass

        return await compose_final_response(
            session=session,
            sid=sid,
            caller_text=caller_text,
            intent=intent,
            fallback_text=fallback,
            commerce_state=state,
            memory_facts=memory_facts,
            tool_results=tool_results,
            settings=self._settings,
        )


# ── Default ISBN lookup (Shopify) ────────────────────────────────────────────
async def _default_lookup_isbn(
    isbn: str,
) -> tuple[bool, Optional[dict], bool, dict]:
    """Look up a book by ISBN via the Shopify tool. Never searches fragments."""
    from ..tools.shopify_tools import SearchBookByISBN

    try:
        raw_json = await SearchBookByISBN(isbn)
        raw = json.loads(raw_json)
    except Exception as exc:  # noqa: BLE001
        logger.warning("sales_isbn_lookup_error err=%s", type(exc).__name__)
        return False, None, False, {"found": False, "error": "lookup_failed"}

    if raw.get("needs_more_digits"):
        return False, None, True, raw

    results = raw.get("results") or []
    if results and isinstance(results[0], dict):
        candidate = acs.candidate_from_product(results[0], isbn=isbn)
        return True, candidate, False, raw

    if raw.get("found") is False:
        return False, None, False, raw

    return False, None, False, raw


async def _await_send(send: Callable, msg: dict) -> None:
    import asyncio

    out = send(msg)
    if asyncio.iscoroutine(out):
        await out
