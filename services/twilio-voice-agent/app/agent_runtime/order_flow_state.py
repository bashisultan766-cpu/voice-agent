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

ORDER_FLOW_VERSION = "v4.41"

STATUS_IDLE = "idle"
STATUS_AWAITING_ORDER_NUMBER = "awaiting_order_number"
STATUS_AWAITING_ORDER_VERIFICATION = "awaiting_order_verification"

_ORDER_STATUS_INTENT = re.compile(
    r"\b("
    r"order status|track(?:ing)?(?:\s+number)?|where is my order|"
    r"has it (?:been )?delivered|delivery status|when will (?:it|my order)|"
    r"has it shipped|shipped yet|refund status|cancel(?:lation)?|"
    r"returned|rejected|not delivered|didn.?t receive|facility rejected|sent back"
    r")\b",
    re.IGNORECASE,
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


def _should_skip_order_lookup(
    text: str,
    session: "SessionState | None" = None,
    turn_mode: str = "",
) -> bool:
    """Do not treat ISBN digit chunks as Shopify order numbers."""
    if (turn_mode or "").strip().lower() in ("isbn", "email"):
        return True
    if session is not None:
        if getattr(session, "pending_isbn_buffer", ""):
            return True
        try:
            from .isbn_short_circuit import _isbn_collection_active

            if _isbn_collection_active(session, turn_mode):
                return True
        except Exception:  # noqa: BLE001
            pass
        commerce = getattr(session, "commerce_flow_status", "idle") or "idle"
        t = (text or "").strip()
        digits = "".join(c for c in t if c.isdigit())
        digit_only_order = (
            4 <= len(digits) <= 10
            and _DIGITS_ONLY.match(t)
            and not digits.startswith(("978", "979"))
        )
        if commerce not in ("idle", "") and not order_intent_detected(text) and not digit_only_order:
            return True
    t = (text or "").strip()
    if re.search(r"\b(isbn|book)\b", t, re.I):
        return True
    digits = "".join(c for c in t if c.isdigit())
    # Short digit-only utterances are order numbers, not ISBNs.
    if (
        4 <= len(digits) <= 10
        and _DIGITS_ONLY.match(t)
        and not digits.startswith(("978", "979"))
    ):
        return False
    if len(digits) >= 9:
        return True
    if digits.startswith(("978", "979")) and len(digits) >= 4:
        return True
    return False


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
    if order_num:
        return order_num
    return None


def extract_email_from_turn(text: str) -> Optional[str]:
    m = _EMAIL_IN_TEXT.search(text or "")
    return m.group(0).lower() if m else None


def order_intent_detected(text: str) -> bool:
    return bool(_ORDER_STATUS_INTENT.search(text or ""))


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
    if order_num:
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

    if order_num:
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

    text = (caller_text or "").strip()
    order_num = (
        extract_order_number(text, session, turn_mode=turn_mode)
        or getattr(session, "pending_order_number", "")
        or getattr(session, "last_order_number", "")
    )
    if turn_mode == "order" and not order_num:
        order_num = normalize_order_number_from_speech(text)

    if not order_num:
        return None

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
        from .not_found_escalation_flow import try_escalate_unresolved_query

        esc = await try_escalate_unresolved_query(
            session,
            caller_text=text,
            query_type="order",
            issue_title=f"Order {order_num} not found in Shopify",
            issue_detail=(
                f"Customer asked about order {order_num}. "
                "Shopify lookup returned no matching order. "
                "Do not invent order data — manual lookup required."
            ),
            api_context={
                "order_number": order_num,
                "shopify_found": False,
                "enrichment": result.order,
            },
            reason="order_not_found",
            what_agent_tried=f"Shopify order lookup for order {order_num}",
            recommended_next_action="Locate the order manually and email the customer.",
        )
        return OrderTurnHint(
            force_reply=esc.force_reply or (
                f"I couldn't find order {order_num}. Could you double-check the number?"
            ),
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
