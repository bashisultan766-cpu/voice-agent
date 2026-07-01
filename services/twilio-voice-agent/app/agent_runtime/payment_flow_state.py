"""
Payment flow compatibility layer (v4.26).

Gates, enforcement, and tool-result helpers. State transitions live in
``app.payment.payment_state_machine``; send logic in ``payment_link_service``.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Optional, TYPE_CHECKING

from ..payment.payment_link_service import (
    PAYMENT_FAILURE_MESSAGE,
    PAYMENT_SUCCESS_MESSAGE,
)
from ..payment.payment_state_machine import (
    PaymentTurnHint,
    _cart_has_confirmed_items,
    confirmation_prompt,
    email_capture_context_active,
    extract_email_from_text,
    in_payment_flow,
    process_payment_turn,
    repeat_email_prompt,
    speak_confirmation_prompt,
)

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_DIRECT_LINK_PHRASE = re.compile(
    r"\b(use|using|provide|giving|give)\s+(you\s+)?(the\s+)?(direct\s+)?(url|link)\b"
    r"|\bdirect\s+(url|link)\b",
    re.I,
)
_FALSE_SUCCESS_PAT = re.compile(
    r"\b("
    r"sent|created|emailed|payment link|checkout link|"
    r"direct url|provided url|use the url|link from our conversation"
    r")\b",
    re.I,
)
_RAW_URL_PAT = re.compile(r"https?://\S+", re.I)


def scrub_false_payment_claims(text: str) -> str:
    """Remove premature checkout/order claims and forbidden direct-link phrasing."""
    if not text:
        return text
    if _RAW_URL_PAT.search(text):
        return PAYMENT_FAILURE_MESSAGE
    if _DIRECT_LINK_PHRASE.search(text):
        return PAYMENT_FAILURE_MESSAGE
    if re.search(r"\border\s+(number\s+)?D\d+\b", text, re.I) and _FALSE_SUCCESS_PAT.search(text):
        return PAYMENT_FAILURE_MESSAGE
    return text


@dataclass
class PaymentGateResult:
    allowed: bool
    tool_json: str = ""
    reason: str = ""


from ..payment.email_state import (
    confirm_payment_email,
    get_canonical_confirmed_email,
    get_pending_payment_email,
    log_payment_flow_diagnostics,
    reject_pending_payment_email,
    set_pending_payment_email,
    sync_payment_email_fields,
)


def _sync_legacy_email_fields(session: "SessionState") -> None:
    sync_payment_email_fields(session)


def resolve_tool_email(args: dict, session: "SessionState") -> str:
    """Return canonical confirmed email for payment send (never raw LLM args)."""
    sync_payment_email_fields(session)
    return get_canonical_confirmed_email(session)


def resolve_tool_email_arg(args: dict) -> str:
    """Read email from tool arguments only — for validation against confirmed."""
    for key in ("email", "customer_email", "to_email"):
        val = (args or {}).get(key) or ""
        if isinstance(val, str) and val.strip():
            return val.strip().lower()
    return ""


def build_payment_tool_result(
    *,
    success: bool,
    email_sent: bool = False,
    customer_message: str = "",
    error_code: str = "",
    retryable: bool = False,
    escalation_recommended: bool = False,
    internal_checkout_url: str = "",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "success": success,
        "email_sent": email_sent,
        "customer_message": customer_message,
        "error_code": error_code,
        "retryable": retryable,
        "escalation_recommended": escalation_recommended,
    }
    if customer_message:
        payload["error"] = customer_message
    if internal_checkout_url:
        payload["_internal_only"] = {"checkout_url": internal_checkout_url}
    return payload


def gate_send_payment_link(session: "SessionState", tool_email: str = "") -> PaymentGateResult:
    """Hard gate before send_payment_link executes."""
    from ..payment.email_state import assert_ready_for_payment_send

    _sync_legacy_email_fields(session)
    log_payment_flow_diagnostics(session, stage="gate_send_payment_link")

    if not _cart_has_confirmed_items(session):
        session.last_payment_attempt_status = "blocked"
        logger.error(
            "payment_send_blocked sid=%s reason=empty_cart",
            (session.call_sid or "")[:6],
        )
        payload = build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=(
                "I need to confirm the book before I can send a payment link. "
                "Which book would you like to order?"
            ),
            error_code="empty_cart",
            retryable=True,
        )
        return PaymentGateResult(allowed=False, tool_json=json.dumps(payload), reason="empty_cart")

    if not assert_ready_for_payment_send(session, stage="gate_send_payment_link"):
        pending = get_pending_payment_email(session)
        if pending:
            msg = confirmation_prompt(pending)
        else:
            msg = (
                "I need a confirmed email address to send the payment link. "
                "What email should I use?"
            )
        session.last_payment_attempt_status = "blocked"
        payload = build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=msg,
            error_code="email_unconfirmed",
            retryable=True,
        )
        return PaymentGateResult(
            allowed=False, tool_json=json.dumps(payload), reason="email_unconfirmed",
        )

    if tool_email:
        from ..payment.safety import validate_tool_email_arg

        arg_result = validate_tool_email_arg(tool_email, session)
        if not arg_result.allowed:
            session.last_payment_attempt_status = "blocked"
            session.payment_block_count = getattr(session, "payment_block_count", 0) + 1
            payload = build_payment_tool_result(
                success=False,
                email_sent=False,
                customer_message=arg_result.safe_message,
                error_code=arg_result.reason,
                retryable=arg_result.reason in ("email_unconfirmed", "no_confirmed_email", "no_email"),
            )
            return PaymentGateResult(
                allowed=False, tool_json=json.dumps(payload), reason=arg_result.reason,
            )

    return PaymentGateResult(allowed=True)


_HOLD_PAT = re.compile(
    r"\b(?:hold(?:\s+on)?|wait|just\s+(?:hold|wait|second|moment)(?:\s+a\s+(?:second|moment))?|"
    r"one\s+(?:second|moment)|give\s+me\s+a\s+(?:second|moment))\b",
    re.I,
)
_REPEAT_PAYMENT_PAT = re.compile(
    r"\b("
    r"repeat(?: that| what you said| the email| my email)?|what did you say|"
    r"say that again|spell(?: it)? again|what was that|pardon"
    r")\b",
    re.I,
)
_PAYMENT_CONFUSION_PAT = re.compile(
    r"\b(what\??|huh|sorry\??|didn.?t (?:hear|catch)|are you there)\s*$",
    re.I,
)
_CHECKOUT_PAYMENT_INTENT_PAT = re.compile(r"\b(checkout|payment)\b", re.I)

PAYMENT_LINK_VOICE_TEMPLATE = (
    "You will receive a secure Shopify payment link. "
    "It contains your order summary."
)
PAYMENT_LINK_DUPLICATE_MESSAGE = (
    "I already sent your secure Shopify payment link for this order. "
    "Please check your email."
)


@dataclass
class PaymentCheckoutHint:
    force_reply: Optional[str] = None
    openai_skipped: bool = False
    send_payment_link: bool = False
    checkout_items: list[dict[str, Any]] = field(default_factory=list)
    blocked_duplicate: bool = False


def checkout_payment_intent_detected(text: str) -> bool:
    """True when caller asks to checkout or pay (deterministic trigger)."""
    return bool(_CHECKOUT_PAYMENT_INTENT_PAT.search(text or ""))


def build_session_checkout_invoice(session: "SessionState") -> dict[str, Any]:
    """Build checkout payload from session cart only — items, quantities, total."""
    from ..cart.session import get_ledger
    from ..payment.payment_destination_groups import group_checkout_items, refresh_payment_groups_from_cart

    refresh_payment_groups_from_cart(session)
    ledger = get_ledger(session)
    items = list(group_checkout_items(session) or ledger.to_checkout_items())
    lines: list[dict[str, Any]] = []
    subtotal = 0.0
    for item in items:
        qty = max(1, int(item.get("quantity", 1) or 1))
        title = (item.get("title") or "").strip()
        line_total: float | None = None
        price_raw = item.get("price")
        if price_raw:
            try:
                unit = float(str(price_raw).replace("$", "").replace(",", ""))
                line_total = unit * qty
                subtotal += line_total
            except (TypeError, ValueError):
                line_total = None
        lines.append({
            "product_title": title,
            "variant_id": item.get("variant_id") or "",
            "quantity": qty,
            "line_total": line_total,
        })
    return {
        "items": items,
        "lines": lines,
        "total_copies": sum(line["quantity"] for line in lines),
        "total_price": round(subtotal, 2) if subtotal > 0 else None,
        "summary_text": ledger.cart_summary_text(),
    }


def try_payment_checkout_short_circuit(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> Optional[PaymentCheckoutHint]:
    """
    Deterministic checkout/payment — mirrors order/product cart short-circuits.

    Requires ``payment_cart_confirmed`` and checkout/payment intent. Sends via
    existing ``send_payment_link`` tool only (no LLM invoice text).
    """
    text = (caller_text or "").strip()
    if not text or not checkout_payment_intent_detected(text):
        return None

    mode = (turn_mode or "").strip().lower()
    if mode in ("order", "isbn"):
        return None

    session.payment_cart_confirmed = bool(
        getattr(session, "payment_cart_confirmed", False)
    ) or _cart_has_confirmed_items(session)
    if not session.payment_cart_confirmed:
        return PaymentCheckoutHint(
            force_reply=(
                "I need to confirm the books in your cart before checkout. "
                "Which book would you like to order?"
            ),
            openai_skipped=True,
        )

    if getattr(session, "payment_link_sent", False):
        return PaymentCheckoutHint(
            force_reply=PAYMENT_LINK_DUPLICATE_MESSAGE,
            openai_skipped=True,
            blocked_duplicate=True,
        )

    invoice = build_session_checkout_invoice(session)
    items = invoice.get("items") or []
    if not items:
        return PaymentCheckoutHint(
            force_reply=(
                "Your cart looks empty right now. "
                "Tell me the ISBN or title of the book you want."
            ),
            openai_skipped=True,
        )

    from ..payment.email_state import assert_ready_for_payment_send, get_canonical_confirmed_email
    from ..payment.payment_prompts import payment_email_collection_prompt
    from ..payment.payment_state_machine import begin_awaiting_payment_email

    if not assert_ready_for_payment_send(session, stage="payment_checkout_short_circuit"):
        begin_awaiting_payment_email(session)
        return PaymentCheckoutHint(
            force_reply=payment_email_collection_prompt(
                cart_summary=str(invoice.get("summary_text") or ""),
            ),
            openai_skipped=True,
        )

    confirmed_email = get_canonical_confirmed_email(session) or ""
    from ..payment.payment_idempotency import check_idempotency, compute_idempotency_key

    group_id = "default"
    groups = getattr(session, "payment_destination_groups", None) or []
    if groups and isinstance(groups[0], dict):
        group_id = str(groups[0].get("group_id") or "default")
    idem_key = compute_idempotency_key(
        call_sid=getattr(session, "call_sid", "") or "",
        group_id=group_id,
        items=items,
        confirmed_email=confirmed_email,
    )
    idem = check_idempotency(idem_key)
    if not idem.allowed:
        return PaymentCheckoutHint(
            force_reply=idem.message or PAYMENT_LINK_DUPLICATE_MESSAGE,
            openai_skipped=True,
            blocked_duplicate=True,
        )

    logger.info(
        "payment_checkout_short_circuit sid=%s items=%d total_copies=%d total_price=%s",
        (getattr(session, "call_sid", "") or "")[:6],
        len(items),
        invoice.get("total_copies"),
        invoice.get("total_price"),
    )
    return PaymentCheckoutHint(
        force_reply=PAYMENT_LINK_VOICE_TEMPLATE,
        openai_skipped=True,
        send_payment_link=True,
        checkout_items=items,
    )


def record_payment_voice_reply(session: "SessionState", reply: str) -> None:
    """Cache last deterministic payment/email speech for repeat/brain-gate replay."""
    text = (reply or "").strip()
    if not text:
        return
    session.payment_last_voice_reply = text
    session.last_spoken_response = text


def try_payment_hold_reply(session: "SessionState", caller_text: str) -> Optional[str]:
    """Acknowledge hold/wait during email capture without invoking the LLM."""
    if not _HOLD_PAT.search(caller_text or ""):
        return None
    if getattr(session, "awaiting_payment_email_confirmation", False):
        pending = get_pending_payment_email(session)
        if pending:
            return "No rush — just say yes if the email is correct, or tell me the right one."
        return "No rush — tell me your email when you're ready."
    if getattr(session, "awaiting_payment_email", False) or (
        getattr(session, "payment_flow_status", "") or ""
    ) == "awaiting_email":
        return "Sure — take your time. What email should I send the payment link to?"
    return None


def try_payment_repeat_reply(session: "SessionState", caller_text: str) -> Optional[str]:
    """Replay email confirmation or collection prompts from this call."""
    from ..email.capture import is_repeat_email_request, is_email_spell_request
    from ..payment.payment_state_machine import repeat_email_prompt

    text = (caller_text or "").strip()
    if not text:
        return None
    if not (
        _REPEAT_PAYMENT_PAT.search(text)
        or _PAYMENT_CONFUSION_PAT.match(text)
        or is_repeat_email_request(text)
        or is_email_spell_request(text)
    ):
        return None

    last = (getattr(session, "payment_last_voice_reply", "") or "").strip()
    if last:
        return last

    pending = get_pending_payment_email(session)
    if pending:
        return repeat_email_prompt(pending)

    if getattr(session, "awaiting_payment_email", False) or (
        getattr(session, "payment_flow_status", "") or ""
    ) in ("awaiting_email", "awaiting_email_confirmation"):
        from ..payment.payment_prompts import payment_email_collection_prompt

        return payment_email_collection_prompt()
    return None


def try_payment_brain_gate(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> Optional[str]:
    """
    Prevent the LLM from reformatting payment/email steps or inventing send success.
    Returns a deterministic replay when payment email context is active.
    """
    from ..payment.payment_state_machine import (
        email_capture_context_active,
        in_payment_flow,
    )

    if not (
        email_capture_context_active(session, turn_mode)
        or in_payment_flow(session)
        or getattr(session, "awaiting_payment_email", False)
        or getattr(session, "awaiting_payment_email_confirmation", False)
    ):
        return None

    hold = try_payment_hold_reply(session, caller_text)
    if hold:
        return hold

    repeat = try_payment_repeat_reply(session, caller_text)
    if repeat:
        return repeat

    confirm = spoken_email_confirmation(session)
    if confirm and getattr(session, "awaiting_payment_email_confirmation", False):
        if _FALSE_SUCCESS_PAT.search(caller_text or ""):
            return confirm
        return None

    if getattr(session, "payment_link_sent", False):
        last = (getattr(session, "payment_last_voice_reply", "") or "").strip()
        if last and (_REPEAT_PAYMENT_PAT.search(caller_text or "") or _PAYMENT_CONFUSION_PAT.match(caller_text or "")):
            return last

    return None


def spoken_email_confirmation(session: "SessionState") -> Optional[str]:
    """
    Return the customer-facing email confirmation prompt with the FULL normalized
    email when we are awaiting confirmation.

    Payment email confirmation is an explicit exception to privacy masking rules.
    """
    if not getattr(session, "awaiting_payment_email_confirmation", False):
        return None
    pending = get_pending_payment_email(session)
    if not pending:
        return None
    return confirmation_prompt(pending)


def enforce_payment_response(
    session: "SessionState",
    llm_text: str,
    tool_results: list[tuple[str, dict]],
) -> str:
    """Override LLM final text when payment tool results contradict it."""
    confirm = spoken_email_confirmation(session)
    if confirm:
        if not llm_text or _FALSE_SUCCESS_PAT.search(llm_text or "") or "***" in (llm_text or ""):
            return confirm
        if pending := get_pending_payment_email(session):
            local = pending.split("@", 1)[0]
            if local.lower() not in (llm_text or "").lower():
                return confirm

    blocked_checkout = [
        (n, r) for n, r in tool_results
        if n == "create_checkout" and not r.get("success", True)
    ]
    if blocked_checkout and _FALSE_SUCCESS_PAT.search(llm_text or ""):
        _name, result = blocked_checkout[-1]
        return result.get("error") or result.get("customer_message") or llm_text

    payment_calls = [(n, r) for n, r in tool_results if n == "send_payment_link"]
    if payment_calls:
        _name, result = payment_calls[-1]
        if result.get("success") and result.get("email_sent"):
            session.last_payment_attempt_status = "success"
            session.payment_flow_result = {"email_sent": True, "success": True}
            session.email_send_success = True
            session.payment_link_sent = True
            return result.get("customer_message") or PAYMENT_SUCCESS_MESSAGE
        session.last_payment_attempt_status = "failed"
        session.payment_flow_result = {"email_sent": False, "success": False}
        session.email_send_success = False
        return result.get("customer_message") or PAYMENT_FAILURE_MESSAGE

    if session.awaiting_payment_email_confirmation:
        pending = session.pending_payment_email or session.pending_email
        if pending and _FALSE_SUCCESS_PAT.search(llm_text or ""):
            return confirmation_prompt(pending)

    return scrub_false_payment_claims(llm_text)


def parse_tool_result(result_str: str) -> dict:
    try:
        data = json.loads(result_str)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}
