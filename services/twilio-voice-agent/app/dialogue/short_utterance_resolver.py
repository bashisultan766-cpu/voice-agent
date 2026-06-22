"""
Contextual yes/no/short utterance resolver (v4.9).

Resolves ambiguous short turns using session context before EricDialogueBrain.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from ..state.models import SessionState

_YES_ONLY = re.compile(
    r"^\s*(yes\.?|yeah\.?|yep\.?|correct\.?|that.?s right\.?|right\.?|affirmative)\s*$",
    re.IGNORECASE,
)
_NO_ONLY = re.compile(
    r"^\s*(no\.?|nope\.?|incorrect\.?|that.?s wrong\.?|wrong\.?)\s*$",
    re.IGNORECASE,
)
_OKAY_ONLY = re.compile(
    r"^\s*(okay\.?|ok\.?|sure\.?|alright\.?|got it\.?)\s*$",
    re.IGNORECASE,
)
_TOO_ALSO = re.compile(
    r"^\s*(too\.?|also\.?|as well\.?|along with the other one\.?|"
    r"along with the other\.?|and the other one\.?)\s*$",
    re.IGNORECASE,
)


@dataclass
class ShortUtteranceResult:
    resolved: bool = False
    intent: str = ""
    confidence: float = 0.92
    reason: str = ""


def _dialogue_state(session: "SessionState"):
    from ..dialogue.manager import DialogueManager
    return DialogueManager.get_state(session)


def _ledger(session: "SessionState"):
    from ..cart.session import get_ledger
    return get_ledger(session)


def resolve_short_utterance(
    text: str,
    session: "SessionState",
    *,
    input_intent: str = "",
    last_worker_result: Optional[dict] = None,
) -> ShortUtteranceResult:
    """
    Resolve short contextual utterances using expected_next and active flow.

    Returns resolved=False to pass through to EricDialogueBrain.
    """
    t = (text or "").strip()
    if not t:
        return ShortUtteranceResult()

    state = _dialogue_state(session)
    expected = state.expected_next or ""
    active = state.active_flow or ""
    pfs = getattr(session, "payment_flow_status", "idle") or "idle"
    ledger = _ledger(session)

    # ── "Too" / "also" / continuation ────────────────────────────────────────
    if _TOO_ALSO.match(t):
        if active in ("cart_building", "isbn_collection", "payment", "checkout") or ledger.confirmed_count():
            return ShortUtteranceResult(
                resolved=True,
                intent="add_to_cart",
                reason="cart_continuation",
            )
        if ledger.candidate_item:
            return ShortUtteranceResult(
                resolved=True,
                intent="add_to_cart",
                reason="candidate_keep",
            )

    # ── Yes ────────────────────────────────────────────────────────────────────
    if _YES_ONLY.match(t) or (
        t.lower().startswith("yes") and len(t.split()) <= 3
    ):
        if pfs == "awaiting_send_confirmation":
            return ShortUtteranceResult(
                resolved=True, intent="payment_execute", reason="payment_final_yes",
            )
        if pfs == "awaiting_email_confirmation" or expected == "email_confirmation":
            return ShortUtteranceResult(
                resolved=True, intent="email_confirmation", reason="email_readback_yes",
            )
        if expected == "confirm_product" or (
            active in ("cart_building", "isbn_collection") and ledger.candidate_item
        ):
            return ShortUtteranceResult(
                resolved=True, intent="add_to_cart", reason="product_confirm_yes",
            )
        if active in ("facility_approval", "address_update", "cancellation"):
            return ShortUtteranceResult(
                resolved=True, intent=input_intent or "confirmation", reason="flow_proceed_yes",
            )
        if "send" in t.lower() and pfs in ("awaiting_send_confirmation", "checkout_created"):
            return ShortUtteranceResult(
                resolved=True, intent="payment_execute", reason="yes_send_it",
            )

    # ── No ─────────────────────────────────────────────────────────────────────
    if _NO_ONLY.match(t):
        if pfs == "awaiting_email_confirmation":
            return ShortUtteranceResult(
                resolved=True, intent="email_correction", reason="email_readback_no",
            )

    # ── Okay ───────────────────────────────────────────────────────────────────
    if _OKAY_ONLY.match(t):
        pfr = getattr(session, "payment_flow_result", {}) or {}
        if pfr.get("email_sent") or pfs == "payment_sent":
            return ShortUtteranceResult(
                resolved=True, intent="ending_thanks", reason="post_payment_ack",
            )
        if expected == "confirm_product" and ledger.candidate_item:
            return ShortUtteranceResult(
                resolved=True, intent="add_to_cart", reason="okay_confirm_product",
            )
        # Do not add random items from bare "okay"
        if ledger.candidate_item and expected != "confirm_product":
            return ShortUtteranceResult(resolved=False, reason="okay_ambiguous")

    return ShortUtteranceResult()
