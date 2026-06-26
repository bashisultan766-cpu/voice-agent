"""Planner agent — tool execution plan with Step 2 safety gates."""
from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Optional

from .types import PlanStep, PlannerResult, SupervisorResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_ISBN = re.compile(r"\b(?:97[89]\d{10}|\d{9}[\dXx]|\d{13})\b")
_ORDER_NUM = re.compile(r"\b(?:order\s*)?#?\s*(\d{4,8})\b", re.I)
_COMPARE = re.compile(r"\bcompare\b", re.I)
_MAGAZINE = re.compile(r"\b(magazines?|periodicals?)\b", re.I)
_NEWSPAPER = re.compile(r"\b(newspapers?|paper subscription)\b", re.I)
_DELIVERY_ISSUE = re.compile(
    r"\b(not delivered|wasn't delivered|not received|returned|sent back|rejected)\b",
    re.I,
)


def build_plan(
    supervisor: SupervisorResult,
    user_text: str,
    session: "SessionState",
) -> PlannerResult:
    """Deterministic planner — no LLM required for certification paths."""
    intent = supervisor.intent

    if intent == "product_request_clarification":
        return PlannerResult(
            steps=[],
            customer_message=supervisor.clarifying_question or "",
        )

    if intent == "checkout_payment":
        return _plan_checkout_payment(session)

    if intent == "product_search":
        return _plan_product_search(user_text, supervisor)

    if intent == "order_status":
        return _plan_order_status(user_text, session)

    if intent == "refund_status":
        return _plan_refund_status(user_text, session)

    if intent == "cart_update":
        return PlannerResult(
            steps=[PlanStep(tool="get_cart", args={}, can_run_parallel=True)],
            customer_facing_progress_message="Let me check your cart.",
        )

    if intent == "facility_question":
        return _plan_facility_question(user_text, session)

    if intent == "shipping_question":
        return PlannerResult(
            steps=[PlanStep(tool="shipping_policy_lookup", args={}, can_run_parallel=True)],
            customer_facing_progress_message="Let me pull up our shipping information.",
        )

    if intent == "faq":
        return PlannerResult(
            steps=[PlanStep(tool="faq_lookup", args={"question": user_text}, can_run_parallel=True)],
            customer_facing_progress_message="Let me check that for you.",
        )

    if intent == "escalation":
        return PlannerResult(
            steps=[
                PlanStep(
                    tool="escalate_to_human",
                    args={"reason": "caller_request", "summary": user_text[:200]},
                    can_run_parallel=False,
                ),
            ],
            customer_facing_progress_message="I'll connect you with our team.",
        )

    return PlannerResult(
        steps=[],
        customer_facing_progress_message="",
    )


async def run_planner(
    supervisor: SupervisorResult,
    user_text: str,
    session: "SessionState",
    *,
    memory_summary: str = "",
    settings: Optional[object] = None,
) -> PlannerResult:
    """Build execution plan; uses deterministic rules (LLM optional later)."""
    plan = build_plan(supervisor, user_text, session)
    logger.info(
        "planner_built sid=%s intent=%s steps=%d blocked=%s",
        (session.call_sid or "")[:6],
        supervisor.intent,
        len(plan.steps),
        plan.blocked,
    )
    return plan


def _plan_checkout_payment(session: "SessionState") -> PlannerResult:
    from ..payment.safety import assert_payment_link_allowed

    safety = assert_payment_link_allowed(session)
    if not safety.allowed:
        return PlannerResult(
            steps=[],
            blocked=True,
            block_reason=safety.reason,
            customer_message=safety.safe_message,
        )

    email = (getattr(session, "confirmed_email", "") or "").strip()
    steps = [PlanStep(tool="send_payment_link", args={"email": email}, can_run_parallel=False)]
    if not (
        getattr(session, "pending_checkout_url", "")
        or getattr(session, "checkout_url", "")
    ):
        steps.insert(
            0,
            PlanStep(tool="create_checkout", args={}, can_run_parallel=False, depends_on=[]),
        )

    return PlannerResult(
        steps=steps,
        requires_confirmation_before_execution=False,
        customer_facing_progress_message="I'll email your secure payment link.",
    )


def _plan_product_search(user_text: str, supervisor: SupervisorResult) -> PlannerResult:
    from .intent_router import is_vague_product_request, resolve_product_request_clarification

    if is_vague_product_request(user_text):
        return PlannerResult(
            steps=[],
            customer_message=resolve_product_request_clarification(user_text),
        )

    isbn_match = _ISBN.search(user_text)
    query = isbn_match.group(0) if isbn_match else user_text.strip()

    if _COMPARE.search(user_text):
        parts = re.split(r"\band\b|\bvs\b|,", user_text, flags=re.I)
        queries = [p.strip() for p in parts if p.strip() and len(p.strip()) > 3][:2]
        if len(queries) >= 2:
            return PlannerResult(
                steps=[
                    PlanStep(tool="search_products", args={"query": queries[0]}, can_run_parallel=True),
                    PlanStep(tool="search_products", args={"query": queries[1]}, can_run_parallel=True),
                ],
                customer_facing_progress_message="Let me check those books for you.",
            )

    return PlannerResult(
        steps=[PlanStep(tool="search_products", args={"query": query}, can_run_parallel=True)],
        customer_facing_progress_message=(
            "Let me check that ISBN." if isbn_match else "I'll look that up."
        ),
    )


def _plan_facility_question(user_text: str, session: "SessionState") -> PlannerResult:
    from ..facility.policy_service import detect_content_type_from_text

    facility = _extract_facility_name(user_text) or getattr(session, "last_facility_name", "")
    state = _extract_state(user_text) or getattr(session, "last_facility_state", "")
    content_type = _detect_facility_content_type(user_text)
    order_match = _ORDER_NUM.search(user_text)
    order_number = order_match.group(1) if order_match else ""
    email = (getattr(session, "confirmed_email", "") or "").strip()

    if order_number and _DELIVERY_ISSUE.search(user_text):
        return PlannerResult(
            steps=[
                PlanStep(
                    tool="explain_facility_delivery_rejection",
                    args={
                        "facility_name": facility,
                        "content_type": content_type or "book",
                        "state": state,
                        "order_number": order_number,
                        "email": email,
                        "phone": "",
                        "product_title": _extract_product_title(user_text),
                    },
                    can_run_parallel=False,
                ),
            ],
            customer_facing_progress_message="I'll check that facility policy.",
        )

    if _DELIVERY_ISSUE.search(user_text) or re.search(
        r"\b(why was|facility reject|get a refund)\b", user_text or "", re.I
    ):
        return PlannerResult(
            steps=[
                PlanStep(
                    tool="explain_facility_delivery_rejection",
                    args={
                        "facility_name": facility,
                        "content_type": content_type or "",
                        "state": state,
                        "product_title": _extract_product_title(user_text),
                    },
                    can_run_parallel=False,
                ),
            ],
            customer_facing_progress_message="I'll check that facility policy.",
        )

    if content_type and content_type != "unknown":
        return PlannerResult(
            steps=[
                PlanStep(
                    tool="check_facility_content_allowed",
                    args={
                        "facility_name": facility or "unknown facility",
                        "content_type": content_type,
                        "state": state,
                    },
                    can_run_parallel=True,
                ),
            ],
            customer_facing_progress_message="I'll check that facility policy.",
        )

    return PlannerResult(
        steps=[
            PlanStep(
                tool="answer_facility_policy_question",
                args={
                    "facility_name": facility or "unknown facility",
                    "question": user_text,
                    "state": state,
                    "content_type": content_type or "",
                },
                can_run_parallel=True,
            ),
        ],
        customer_facing_progress_message="I'll check that facility policy.",
    )


def _detect_facility_content_type(user_text: str) -> str:
    from ..facility.policy_service import detect_content_type_from_text

    if _MAGAZINE.search(user_text):
        return "magazine"
    if _NEWSPAPER.search(user_text):
        return "newspaper"
    detected = detect_content_type_from_text(user_text)
    return detected if detected != "unknown" else ""


def _extract_state(text: str) -> str:
    m = re.search(r"\b([A-Z]{2})\b", text or "")
    return m.group(1) if m else ""


def _extract_product_title(text: str) -> str:
    m = re.search(r"(?:book|title)\s+['\"]?([^'\"?.]+)", text or "", re.I)
    return m.group(1).strip() if m else ""


def _plan_order_status(user_text: str, session: "SessionState") -> PlannerResult:
    order_match = _ORDER_NUM.search(user_text)
    order_number = order_match.group(1) if order_match else ""
    email = (getattr(session, "confirmed_email", "") or "").strip()
    args: dict = {"order_number": order_number, "email": email, "phone": ""}
    return PlannerResult(
        steps=[PlanStep(tool="lookup_order_status", args=args, can_run_parallel=True)],
        customer_facing_progress_message="Let me check that order.",
    )


def _plan_refund_status(user_text: str, session: "SessionState") -> PlannerResult:
    order_match = _ORDER_NUM.search(user_text)
    order_number = order_match.group(1) if order_match else ""
    email = (getattr(session, "confirmed_email", "") or "").strip()
    return PlannerResult(
        steps=[
            PlanStep(
                tool="lookup_refund_status",
                args={"order_number": order_number, "email": email, "phone": ""},
                can_run_parallel=True,
            ),
        ],
        customer_facing_progress_message="I'll check the refund status.",
    )


def _extract_facility_name(text: str) -> str:
    m = re.search(
        r"([A-Za-z][A-Za-z0-9\s\-]{2,50})\s+(?:facility|prison|jail|correctional)\b",
        text or "",
        re.I,
    )
    if m:
        return m.group(1).strip()
    m = re.search(r"(?:facility|prison|jail)\s+([A-Za-z0-9\s\-]{3,40})", text or "", re.I)
    return m.group(1).strip() if m else ""
