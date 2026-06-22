"""Payment checkout scope audit before sending link (v4.7)."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_SCOPE_COUNT = re.compile(
    r"\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+books?\b",
    re.IGNORECASE,
)
_BOTH = re.compile(r"\b(both|these two|those two)\b", re.IGNORECASE)
_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}


@dataclass
class PaymentScopeAudit:
    requested_count: int | None = None
    confirmed_count: int = 0
    checkout_count: int = 0
    excluded_count: int = 0
    excluded_reasons: list[str] = field(default_factory=list)
    titles_included: list[str] = field(default_factory=list)
    source_origins: list[str] = field(default_factory=list)
    blocked: bool = False
    clarification_message: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "requested_count": self.requested_count,
            "confirmed_count": self.confirmed_count,
            "checkout_count": self.checkout_count,
            "excluded_count": self.excluded_count,
            "excluded_reasons": self.excluded_reasons[:10],
            "titles_included": self.titles_included[:20],
            "source_origins": self.source_origins[:20],
            "blocked": self.blocked,
        }


def _eligible_items(session: "SessionState") -> list[dict[str, Any]]:
    from ..payment.line_item_filter import detect_internal_fee_item

    items: list[dict] = []
    for raw in getattr(session, "cart_items", []) or []:
        if not isinstance(raw, dict):
            continue
        if raw.get("confirmation_status") != "confirmed":
            continue
        if raw.get("eligible_for_checkout") is False:
            continue
        if not raw.get("variant_id"):
            continue
        if detect_internal_fee_item(raw):
            logger.warning(
                "payment_scope_audit excluded internal_fee title=%s",
                str(raw.get("title", ""))[:30],
            )
            continue
        items.append(raw)
    return items


def _parse_requested_count(raw_text: str, entities: dict) -> int | None:
    if entities.get("requested_cart_count"):
        try:
            return int(entities["requested_cart_count"])
        except (TypeError, ValueError):
            pass
    if entities.get("payment_scope") == "both":
        return 2
    t = raw_text.lower()
    if _BOTH.search(t):
        return 2
    m = _SCOPE_COUNT.search(t)
    if m:
        val = m.group(1).lower()
        return int(val) if val.isdigit() else _WORDS.get(val)
    return None


def parse_requested_count(raw_text: str, entities: dict, session: "SessionState") -> int | None:
    rc = _parse_requested_count(raw_text, entities)
    if rc:
        return rc
    stored = getattr(session, "payment_scope_count", None)
    if stored:
        try:
            return int(stored)
        except (TypeError, ValueError):
            pass
    if entities.get("payment_scope") == "both":
        return 2
    return None


def audit_payment_scope(
    session: "SessionState",
    entities: dict,
    raw_text: str = "",
) -> tuple[list[dict[str, Any]], PaymentScopeAudit]:
    """
    Build checkout item list and audit. May block with clarification message.
    """
    eligible = _eligible_items(session)
    all_confirmed = [
        r for r in (getattr(session, "cart_items", []) or [])
        if isinstance(r, dict) and r.get("confirmation_status") == "confirmed"
    ]
    excluded = len(all_confirmed) - len(eligible)

    audit = PaymentScopeAudit(
        confirmed_count=len(all_confirmed),
        checkout_count=len(eligible),
        excluded_count=max(0, excluded),
        titles_included=[i.get("title", "")[:60] for i in eligible if i.get("title")],
        source_origins=[i.get("selection_origin", i.get("source", "")) for i in eligible],
    )

    requested = parse_requested_count(raw_text, entities, session)
    audit.requested_count = requested

    for raw in all_confirmed:
        if raw not in eligible:
            reason = "not_eligible_for_checkout"
            if not raw.get("variant_id"):
                reason = "missing_variant_id"
            elif raw.get("candidate_guard_allowed") is False:
                reason = "candidate_guard_blocked"
            elif raw.get("eligible_for_checkout") is False:
                reason = "accidental_search_result"
            audit.excluded_reasons.append(reason)

    sid = getattr(session, "call_sid", "")[:6]
    # Count internal fee items that were excluded before eligible_items ran
    from ..payment.line_item_filter import detect_internal_fee_item
    all_items = getattr(session, "cart_items", []) or []
    excluded_internal_fee = sum(
        1 for i in all_items
        if isinstance(i, dict) and detect_internal_fee_item(i)
    )
    logger.info(
        "payment_scope_audit sid=%s requested=%s confirmed=%d checkout=%d excluded=%d "
        "excluded_internal_fee=%d titles=%d",
        sid,
        audit.requested_count,
        audit.confirmed_count,
        audit.checkout_count,
        audit.excluded_count,
        excluded_internal_fee,
        len(audit.titles_included),
    )

    if requested is not None and audit.checkout_count != requested:
        titles = ", ".join(audit.titles_included[:5]) or "your selected books"
        audit.blocked = True
        audit.clarification_message = (
            f"I have more books selected than expected. I have {titles}. "
            "Which ones should I include?"
        )
        session.payment_scope_audit = audit.to_dict()
        return [], audit

    session.payment_scope_audit = audit.to_dict()
    return eligible, audit
