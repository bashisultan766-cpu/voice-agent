"""
Order / refund / delivery flow for live voice (v4.32).

Deterministic steps before the LLM:
  1. Customer asks about order → ask for order number
  2. Order number received → Shopify enrichment (full details, no email gate)
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

ORDER_FLOW_VERSION = "v4.43"

STATUS_IDLE = "idle"
STATUS_AWAITING_ORDER_NUMBER = "awaiting_order_number"
STATUS_AWAITING_ORDER_VERIFICATION = "awaiting_order_verification"

MIN_ORDER_DIGITS = 5

_ORDER_STATUS_INTENT = re.compile(
    r"\b("
    r"order status|track(?:ing)?(?:\s+number)?|where is my order|"
    r"has it (?:been )?delivered|delivery status|when will (?:it|my order)|"
    r"has it shipped|shipped yet|refund status|cancel(?:lation)?|"
    r"returned|rejected|not delivered|didn.?t receive|facility rejected|sent back"
    r")\b",
    re.IGNORECASE,
)
_ORDER_INFO_INTENT = re.compile(
    r"\b("
    r"information about (?:an? |the )?order|about (?:my|the|an?) order|"
    r"order information|check (?:this|my|the) order|"
    r"need (?:info|information|details?) about (?:an? |the )?order|"
    r"tell me about (?:my|the) order|look up (?:my|the) order|"
    r"looking for (?:my |the |an )?order|"
    r"status of (?:my|the) order|can you check (?:this|my|the) order|"
    r"i need (?:info|information|details?) about (?:an? |the )?order"
    r")\b",
    re.IGNORECASE,
)
_REPEAT_ORDER_NUMBER_PAT = re.compile(
    r"\b("
    r"repeat (?:the )?order number|what (?:was|is) the order number|"
    r"say the order number again|order number again"
    r")\b",
    re.I,
)
_REPEAT_ORDER_SUMMARY_PAT = re.compile(
    r"\b("
    r"repeat (?:what you (?:said|have|found)|that)|what do you have|"
    r"what did you find|can you repeat (?:what|that)|tell me again"
    r")\b",
    re.I,
)
_ORDER_CONFUSION_PAT = re.compile(
    r"\b("
    r"what'?s up|wrong|not correct|not giving|incorrect|"
    r"that(?:'s| is) not|not the right|not matching"
    r")\b",
    re.I,
)
_COMMERCE_BUY_INTENT = re.compile(
    r"\b(?:"
    r"buy|purchase|want to (?:buy|order)|how (?:do|can) i (?:buy|order)|"
    r"process to buy|from your shop|payment link|add to cart|"
    r"shop(?:ping)?|looking for a book|need a book"
    r")\b",
    re.I,
)
_ORDER_CONFIRM_PAT = re.compile(
    r"\b(?:yes\.?\s*)?(?:this is )?(?:the )?correct order(?: number)?\b",
    re.I,
)
_WRONG_ORDER_PAT = re.compile(
    r"\bwrong (?:order )?number|incorrect order|not the right order\b",
    re.I,
)
_OTHER_ORDER_PAT = re.compile(
    r"\b(?:another|other|different|second|next)\s+order\b",
    re.I,
)
_HOLD_PAT = re.compile(
    r"\b(?:hold(?:\s+on)?|wait|just\s+(?:hold|wait|second|moment)(?:\s+a\s+(?:second|moment))?|"
    r"one\s+(?:second|moment)|give\s+me\s+a\s+(?:second|moment))\b",
    re.I,
)
_ORDER_DISPUTE_PAT = re.compile(
    r"\b(?:wrong\s+information|wrong\s+details?|not\s+matching|doesn'?t\s+match|"
    r"detail(?:s)?\s+(?:is|are)\s+not\s+correct|giving\s+the\s+wrong|"
    r"your\s+detail(?:s)?\s+(?:is|are)\s+not\s+correct|information\s+is\s+wrong|"
    r"not\s+the\s+correct\s+(?:one|order))\b",
    re.I,
)
_ORDER_PREAMBLE_PAT = re.compile(
    r"\border\s*(?:number|no\.?|#)\s*is\s*\.?\s*$",
    re.I,
)
_FACILITY_ISSUE_INTENT = re.compile(
    r"\b(returned|rejected|not delivered|didn.?t receive|facility rejected|sent back|"
    r"books? (?:were|was) not (?:delivered|accepted))\b",
    re.IGNORECASE,
)
_ORDER_NUMBER_IN_TEXT = re.compile(
    r"(?:order\s*(?:number|no\.?|#)?\s*)?#?\s*(\d{4,10})\b",
    re.IGNORECASE,
)
_DIGITS_ONLY = re.compile(r"^[\d\s\.\-]+$")
_EMAIL_IN_TEXT = re.compile(
    r"[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}",
    re.IGNORECASE,
)


@dataclass
class OrderTurnHint:
    force_reply: Optional[str] = None
    openai_skipped: bool = False
    enrichment_done: bool = False


def _status(session: "SessionState") -> str:
    return getattr(session, "order_flow_status", STATUS_IDLE) or STATUS_IDLE


def _order_digit_count(num: str) -> int:
    return len(re.sub(r"\D", "", num or ""))


def is_actionable_order_number(num: str) -> bool:
    """Enough digits to run a Shopify order lookup."""
    digits = re.sub(r"\D", "", num or "")
    return (
        MIN_ORDER_DIGITS <= len(digits) <= 10
        and not digits.startswith(("978", "979"))
    )


def _has_order_number_preamble(text: str) -> bool:
    return bool(
        _ORDER_PREAMBLE_PAT.search(text or "")
        or re.search(r"\border\s*(?:number|no\.?|#)\s*is\b", text or "", re.I)
    )


def _should_skip_order_lookup(
    text: str,
    session: "SessionState | None" = None,
    turn_mode: str = "",
) -> bool:
    """Do not treat ISBN digit chunks as Shopify order numbers."""
    if (turn_mode or "").strip().lower() in ("isbn", "email"):
        return True
    t = (text or "").strip()
    digits = "".join(c for c in t if c.isdigit())

    if session is not None:
        if getattr(session, "pending_isbn_buffer", ""):
            return True
        try:
            from .isbn_short_circuit import _isbn_collection_active

            if _isbn_collection_active(session, turn_mode):
                return True
        except Exception:  # noqa: BLE001
            pass
        try:
            from .isbn_short_circuit import resolve_spoken_isbn

            merged_isbn, buf = resolve_spoken_isbn(
                text, session=session, turn_mode=turn_mode,
            )
            if merged_isbn:
                return True
            if buf and len(buf) >= 4:
                return True
        except Exception:  # noqa: BLE001
            pass
        commerce = getattr(session, "commerce_flow_status", "idle") or "idle"
        digit_only_order = (
            4 <= len(digits) <= 8
            and _DIGITS_ONLY.match(t)
            and not digits.startswith(("978", "979"))
        )
        if commerce not in ("idle", "") and not order_intent_detected(text) and not digit_only_order:
            return True

    if re.search(r"\b(isbn|book)\b", t, re.I) and not re.search(
        r"\border\s*(?:number|no\.?|#)\b", t, re.I,
    ):
        return True
    if len(digits) >= 9:
        return True
    if digits.startswith(("978", "979")) and len(digits) >= 4:
        return True
    if (
        4 <= len(digits) <= 8
        and _DIGITS_ONLY.match(t)
        and not digits.startswith(("978", "979"))
    ):
        return False
    return len(digits) >= 9


def normalize_order_number_from_speech(text: str) -> Optional[str]:
    """Extract an order number from spoken or typed caller text."""
    from ..tools.isbn import _spoken_digits_to_string, expand_spoken_repeaters

    t = (text or "").strip()
    if not t:
        return None

    m = _ORDER_NUMBER_IN_TEXT.search(t)
    if m:
        num = m.group(1)
        return num.lstrip("0") or num

    if _DIGITS_ONLY.match(t):
        digits = "".join(c for c in t if c.isdigit())
        if 4 <= len(digits) <= 10 and not digits.startswith(("978", "979")):
            return digits.lstrip("0") or digits

    expanded = expand_spoken_repeaters(t)
    spoken = _spoken_digits_to_string(expanded)
    if 4 <= len(spoken) <= 10 and not spoken.startswith(("978", "979")):
        return spoken.lstrip("0") or spoken

    digits = "".join(c for c in expanded if c.isdigit())
    if 4 <= len(digits) <= 10 and not digits.startswith(("978", "979")):
        return digits.lstrip("0") or digits

    return None


def extract_order_number(
    text: str,
    session: "SessionState | None" = None,
    *,
    turn_mode: str = "",
) -> Optional[str]:
    if _should_skip_order_lookup(text, session, turn_mode):
        return None
    order_num = normalize_order_number_from_speech(text)
    if not order_num:
        return None
    if is_actionable_order_number(order_num):
        return order_num
    if _has_order_number_preamble(text):
        return order_num
    return None


def extract_email_from_turn(text: str) -> Optional[str]:
    m = _EMAIL_IN_TEXT.search(text or "")
    return m.group(0).lower() if m else None


def order_intent_detected(text: str) -> bool:
    t = text or ""
    return bool(
        _ORDER_STATUS_INTENT.search(t)
        or _ORDER_INFO_INTENT.search(t)
        or _OTHER_ORDER_PAT.search(t)
    )


def _commerce_buy_without_order_context(text: str) -> bool:
    """Shopping / buy-process questions are not order-status replays."""
    if not _COMMERCE_BUY_INTENT.search(text or ""):
        return False
    if _OTHER_ORDER_PAT.search(text or ""):
        return False
    if extract_order_number(text):
        return False
    return True


def try_order_followup_reply(session: "SessionState", caller_text: str) -> Optional[str]:
    """Focused answers from cached Shopify order data (card, email, products, etc.)."""
    if not (getattr(session, "last_order_number", "") or "").strip():
        return None
    if _commerce_buy_without_order_context(caller_text):
        return None
    from ..voice.order_voice_reply import (
        compose_order_followup_reply,
        load_order_inner_from_session,
    )

    inner = load_order_inner_from_session(session)
    if not inner:
        return None
    return compose_order_followup_reply(inner, caller_text)


def try_order_repeat_reply(session: "SessionState", caller_text: str) -> Optional[str]:
    """Replay last order number or last spoken order summary from this call."""
    text = (caller_text or "").strip()
    if not text:
        return None
    if _commerce_buy_without_order_context(text):
        return None
    if _WRONG_ORDER_PAT.search(text):
        session.last_order_number = ""
        session.order_last_voice_reply = ""
        session.pending_order_number = ""
        session.order_flow_status = STATUS_AWAITING_ORDER_NUMBER
        return (
            "Sorry about that. Please read your full order number slowly, "
            "one digit at a time."
        )
    last = (getattr(session, "order_last_voice_reply", "") or "").strip()
    if _ORDER_DISPUTE_PAT.search(text) and last:
        return last
    if _REPEAT_ORDER_NUMBER_PAT.search(text):
        if _REPEAT_ORDER_SUMMARY_PAT.search(text) and last:
            return last
        num = (getattr(session, "last_order_number", "") or "").strip().lstrip("#")
        if num:
            spaced = " ".join(num)
            if last:
                return (
                    f"The order number is {spaced}. "
                    "I can repeat the full order summary if you'd like."
                )
            return f"The order number is {spaced}."
    if _REPEAT_ORDER_SUMMARY_PAT.search(text):
        if last:
            return last
        num = (getattr(session, "last_order_number", "") or "").strip().lstrip("#")
        if num:
            return (
                f"I have order {num} on file from this call. "
                "What would you like to know about it?"
            )
    if _ORDER_CONFIRM_PAT.search(text) and last:
        return last
    if re.match(r"^\s*what\??\s*$", text, re.I) and last:
        return last
    if _ORDER_CONFUSION_PAT.search(text) and last:
        return last
    return None


def try_order_hold_reply(session: "SessionState", caller_text: str) -> Optional[str]:
    """Acknowledge hold/wait during order collection without invoking the LLM."""
    if not _HOLD_PAT.search(caller_text or ""):
        return None
    if _status(session) == STATUS_AWAITING_ORDER_NUMBER:
        return "No problem — take your time. Read your order number when you're ready."
    if getattr(session, "last_order_number", ""):
        return "Sure — take your time. Let me know when you have the order number."
    return None


def try_another_order_short_circuit(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> Optional[OrderTurnHint]:
    """When caller asks about a different order, collect a new order number."""
    text = (caller_text or "").strip()
    if not text or not _OTHER_ORDER_PAT.search(text):
        return None
    if extract_order_number(text, session, turn_mode=turn_mode):
        return None
    session.order_flow_status = STATUS_AWAITING_ORDER_NUMBER
    return OrderTurnHint(
        force_reply=(
            "Sure — please read the other order number slowly, one digit at a time."
        ),
        openai_skipped=True,
    )


def try_order_brain_gate(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> Optional[str]:
    """
    Prevent the LLM from reformatting or re-fetching order data already spoken.
    Returns a deterministic replay when order context is established.
    """
    last_reply = (getattr(session, "order_last_voice_reply", "") or "").strip()
    if not last_reply:
        return None
    if _commerce_buy_without_order_context(caller_text):
        return None

    followup = try_order_followup_reply(session, caller_text)
    if followup:
        return followup

    replay = try_order_repeat_reply(session, caller_text)
    if replay:
        return replay

    if _ORDER_DISPUTE_PAT.search(caller_text or ""):
        return last_reply

    spoken_num = extract_order_number(caller_text, session, turn_mode=turn_mode) or ""
    last_num = (getattr(session, "last_order_number", "") or "").strip().lstrip("#")
    if spoken_num and last_num and spoken_num == last_num:
        return last_reply

    if last_num and not spoken_num:
        if order_intent_detected(caller_text) or re.search(
            r"\b(order|refund|shipping|tracking|status|that order|my order|"
            r"wrong|incorrect|not correct|not matching)\b",
            caller_text or "",
            re.I,
        ):
            return last_reply
    return None


def try_order_collection_short_circuit(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> Optional[OrderTurnHint]:
    """When caller asks about an order but has not given a number yet."""
    text = (caller_text or "").strip()
    if not text:
        return None

    if _has_order_number_preamble(text) and not extract_order_number(
        text, session, turn_mode=turn_mode,
    ):
        session.order_flow_status = STATUS_AWAITING_ORDER_NUMBER
        return OrderTurnHint(
            force_reply="Go ahead — I'm listening for your order number.",
            openai_skipped=True,
        )

    if (turn_mode or "").lower() in ("isbn", "email", "order"):
        if (turn_mode or "").lower() == "order":
            return None
    if not order_intent_detected(text):
        return None
    if extract_order_number(text, session, turn_mode=turn_mode):
        return None
    if _should_skip_order_lookup(text, session, turn_mode=turn_mode):
        return None
    session.order_flow_status = STATUS_AWAITING_ORDER_NUMBER
    return OrderTurnHint(
        force_reply=order_collection_prompt(),
        openai_skipped=True,
    )


def facility_issue_detected(text: str) -> bool:
    if _FACILITY_ISSUE_INTENT.search(text or ""):
        return True
    try:
        from ..facility.facility_resolver import facility_rejection_intent

        return facility_rejection_intent(text)
    except Exception:  # noqa: BLE001
        return False


def order_collection_prompt() -> str:
    return (
        "Sure, I can check that for you. Please read your order number slowly, "
        "one digit at a time."
    )


def order_verification_prompt(order_number: str) -> str:
    return (
        f"Thanks. For order {order_number}, please confirm the email address "
        "or phone number on the order so I can pull up the full details."
    )


def prepare_order_turn_context(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> None:
    """LLM-only: track order collection without bypassing the LLM for speech."""
    text = (caller_text or "").strip()
    if not text:
        return

    if order_intent_detected(text) and not getattr(session, "last_order_number", ""):
        session.order_flow_status = STATUS_AWAITING_ORDER_NUMBER

    if re.search(r"\border\b", text, re.I):
        session.pending_isbn_buffer = ""

    order_num = extract_order_number(text, session, turn_mode=turn_mode)
    if not order_num and re.search(r"\border\b", text, re.I):
        order_num = normalize_order_number_from_speech(text)
    if order_num and is_actionable_order_number(order_num):
        session.pending_order_number = order_num
        session.last_order_number = order_num
        session.order_flow_status = STATUS_IDLE
        session.pending_isbn_buffer = ""


def process_order_turn(session: "SessionState", caller_text: str, *, turn_mode: str = "") -> OrderTurnHint:
    """
    Synchronous order-flow hints (collection prompts only).
    Async enrichment is handled by ``try_order_enrichment_short_circuit``.
    """
    text = (caller_text or "").strip()
    if not text:
        return OrderTurnHint()

    status = _status(session)
    order_num = extract_order_number(text, session, turn_mode=turn_mode)

    if order_num and is_actionable_order_number(order_num):
        session.pending_order_number = order_num
        session.last_order_number = order_num
        session.order_flow_status = STATUS_IDLE

    if status == STATUS_AWAITING_ORDER_VERIFICATION and not order_num:
        if extract_email_from_turn(text):
            return OrderTurnHint()

    if order_intent_detected(text) and not order_num and not getattr(session, "last_order_number", ""):
        session.order_flow_status = STATUS_AWAITING_ORDER_NUMBER
        return OrderTurnHint(force_reply=order_collection_prompt(), openai_skipped=True)

    if status == STATUS_AWAITING_ORDER_NUMBER and not order_num:
        if is_bare_ack(text):
            return OrderTurnHint(
                force_reply="No problem — read your order number when you're ready.",
                openai_skipped=True,
            )

    return OrderTurnHint()


def is_bare_ack(text: str) -> bool:
    return bool(
        re.match(
            r"^\s*(yes|yeah|yep|ok|okay|sure|go ahead|ready)\s*\.?\s*$",
            (text or "").strip(),
            re.I,
        )
    )


async def try_order_enrichment_short_circuit(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> Optional[OrderTurnHint]:
    """
    When we have an order number (+ optional verification), run parallel enrichment
    and return a spoken reply without waiting for the LLM to choose tools.
    """
    from .order_parallel_enrichment import enrich_order_parallel

    if _should_skip_order_lookup(caller_text, session, turn_mode=turn_mode):
        return None
    if (turn_mode or "").strip().lower() in ("isbn", "email"):
        return None

    text = (caller_text or "").strip()
    order_num = extract_order_number(text, session, turn_mode=turn_mode) or ""
    if (turn_mode or "").lower() == "order" and not order_num:
        order_num = normalize_order_number_from_speech(text) or ""
    if not order_num:
        pending = (getattr(session, "pending_order_number", "") or "").strip().lstrip("#")
        if pending and (turn_mode or "").lower() == "order":
            order_num = pending

    if not order_num:
        return None

    if not is_actionable_order_number(order_num):
        return OrderTurnHint(
            force_reply=(
                "I only heard part of the order number. "
                "Please continue with the remaining digits."
            ),
            openai_skipped=True,
        )

    last = (getattr(session, "last_order_number", "") or "").strip().lstrip("#")
    cached = (getattr(session, "order_last_voice_reply", "") or "").strip()
    if order_num == last and cached:
        session.order_flow_status = STATUS_IDLE
        session.pending_order_number = ""
        return OrderTurnHint(
            force_reply=cached,
            openai_skipped=True,
            enrichment_done=True,
        )

    email = extract_email_from_turn(text)
    if email:
        session.caller_email = email

    facility_name = (getattr(session, "last_facility_name", "") or "").strip()
    check_facility = facility_issue_detected(text) or bool(facility_name)

    result = await enrich_order_parallel(
        session,
        order_num,
        email=email,
        phone=None,
        facility_name=facility_name,
        check_facility=check_facility,
    )

    if not result.order.get("found"):
        return OrderTurnHint(
            force_reply=result.suggested_response,
            openai_skipped=True,
            enrichment_done=True,
        )

    session.order_flow_status = STATUS_IDLE
    session.pending_order_number = ""
    session.order_context = result.suggested_response[:500]

    return OrderTurnHint(
        force_reply=result.suggested_response,
        openai_skipped=True,
        enrichment_done=True,
    )
