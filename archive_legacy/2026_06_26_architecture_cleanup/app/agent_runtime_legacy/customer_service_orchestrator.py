"""Order/refund/facility customer service orchestrator (v4.14.5)."""
from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_ORDER_PAT = re.compile(
    r"\b(order(?:\s+number)?\s+is|my order is|check order|order status|where is my order)\b",
    re.I,
)
_REFUND_PAT = re.compile(r"\b(refund|money back|charge\s?back)\b", re.I)
_FACILITY_PAT = re.compile(
    r"\b("
    r"facility approved|is this facility allowed|facility allow|"
    r"does this facility allow|restriction|inmate|prison|jail"
    r")\b",
    re.I,
)
_ADDRESS_PAT = re.compile(
    r"\b(update my address|update my shipping address|change shipping address|wrong address)\b",
    re.I,
)
_ORDER_NUM_PAT = re.compile(
    r"\b(?:order(?:\s+number)?\s+is|my order is|refund(?:\s+\w+)*\s+for order|refund for order)\s+#?([A-Za-z0-9-]{3,})",
    re.I,
)
_ORDER_NUM_ALT_PAT = re.compile(r"\b(?:check order|order)\s+#([A-Za-z0-9-]{3,})", re.I)


def _short_sid(sid: str) -> str:
    return sid[:6] if sid else "?"


def route_customer_service_intent(text: str) -> dict[str, Any]:
    normalized = (text or "").strip()
    order_num_match = _ORDER_NUM_PAT.search(normalized) or _ORDER_NUM_ALT_PAT.search(normalized)
    order_number = order_num_match.group(1).strip().lstrip("#") if order_num_match else ""

    if _REFUND_PAT.search(normalized):
        intent = "refund_lookup"
        categories = ["refund_lookup"]
        if order_number:
            return {
                "intent": intent,
                "response_mode": "needs_tools",
                "tool_categories": categories,
                "tool_entities": {"order_number": order_number, "refund_request": "true"},
                "direct_answer": None,
            }
        return {
            "intent": intent,
            "response_mode": "direct_answer",
            "tool_categories": [],
            "direct_answer": "Do you have the order number or email for the refund?",
            "expected_next": "order_or_email",
        }

    if _ORDER_PAT.search(normalized) or order_number:
        if order_number:
            logger.info("order_lookup_started sid=?")
            return {
                "intent": "order_lookup",
                "response_mode": "needs_tools",
                "tool_categories": ["order_lookup"],
                "tool_entities": {"order_number": order_number},
                "direct_answer": None,
            }
        return {
            "intent": "order_lookup",
            "response_mode": "direct_answer",
            "tool_categories": [],
            "direct_answer": "Do you have the order number or email on the order?",
            "expected_next": "order_or_email",
        }

    if _FACILITY_PAT.search(normalized):
        logger.info("facility_lookup_started sid=?")
        return {
            "intent": "facility_approval",
            "response_mode": "needs_tools",
            "tool_categories": ["facility_approval", "facility_restriction"],
            "direct_answer": None,
        }

    if _ADDRESS_PAT.search(normalized):
        return {
            "intent": "address_update",
            "response_mode": "needs_tools",
            "tool_categories": ["escalation", "address_update"],
            "direct_answer": None,
            "expected_next": "verified_order_or_email",
        }

    return {"intent": "unknown", "response_mode": "pass_through", "tool_categories": []}


def compose_order_answer(facts: dict[str, Any]) -> str | None:
    data = facts.get("order_lookup") or facts.get("order_lookup.data") or {}
    if isinstance(data, dict):
        status = data.get("status") or data.get("fulfillment_status") or data.get("order_status")
        if status:
            logger.info("order_lookup_completed sid=?")
            return f"I found your order. The status is {status}."
    return None


def compose_refund_answer(facts: dict[str, Any]) -> str | None:
    data = facts.get("refund_lookup") or {}
    if isinstance(data, dict):
        status = data.get("status") or data.get("refund_status")
        if status:
            logger.info("refund_lookup_completed sid=?")
            return f"Your refund status is {status}."
    return None


def compose_facility_answer(facts: dict[str, Any]) -> str:
    approval = facts.get("facility_approval") or {}
    restriction = facts.get("facility_restriction") or {}
    if isinstance(approval, dict) and approval.get("approved") is True:
        logger.info("facility_lookup_completed sid=?")
        return "That facility looks approved for book orders."
    if isinstance(restriction, dict) and restriction.get("restricted") is True:
        logger.info("facility_lookup_completed sid=?")
        return "That facility has restrictions I can see in our system."
    logger.info("facility_lookup_completed sid=?")
    return (
        "I don't have that facility rule confirmed right now. "
        "I can send this to customer service."
    )


def compose_address_escalation() -> str:
    return (
        "I'll connect you with Jessica to help update your shipping address. "
        "Do you have your order number or email for verification?"
    )
