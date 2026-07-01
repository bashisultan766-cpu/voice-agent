"""
PolicyEngine — highest-priority deterministic gate (runs BEFORE planner).

Can override planner intent. Does not generate speech or execute tools.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from ..tools.isbn import extract_isbn_candidate
from .session_state import V2SessionState
from .types import ConversationStage, Plan, PlanAction, ResponseMode

_CHECKOUT = re.compile(r"\b(checkout|pay|payment link|send (?:the )?link)\b", re.I)
_ORDER_INTENT = re.compile(r"\b(order|order status|track|tracking|refund)\b", re.I)
_ORDER_NUM = re.compile(r"\b#?(\d{4,6})\b")
_YES = re.compile(r"^\s*(yes|yeah|yep|correct|that'?s right|sure)\s*[.!?]?\s*$", re.I)
_NO = re.compile(r"^\s*(no|nope|wrong|not correct|incorrect)\s*[.!?]?\s*$", re.I)
_CART_ADD = re.compile(r"\b(add|put).*(cart)\b", re.I)
_PRODUCT_SEARCH = re.compile(r"\b(book|isbn|title|author|magazine|newspaper)\b", re.I)


@dataclass(frozen=True)
class PolicyDecision:
    """Policy output — TurnController applies commit_patches at commit only."""

    overridden: bool = False
    plan: Optional[Plan] = None
    commit_patches: dict[str, Any] = field(default_factory=dict)
    reason: str = ""
    policy_id: str = ""


class PolicyEngine:
    """Deterministic commerce policy — no LLM, no speech, no tool calls."""

    VERSION = "v2.1"

    def evaluate(self, state: V2SessionState, user_text: str) -> PolicyDecision:
        text = (user_text or "").strip()

        cart_block = self._cart_prioritization(state, text)
        if cart_block.overridden:
            return cart_block

        payment_block = self._payment_gating(state, text)
        if payment_block.overridden:
            return payment_block

        email_block = self._email_enforcement(state, text)
        if email_block.overridden:
            return email_block

        capture_block = self._email_capture(state, text)
        if capture_block.overridden:
            return capture_block

        order_block = self._order_lookup_validation(state, text)
        if order_block.overridden:
            return order_block

        return PolicyDecision(reason="policy_pass", policy_id="pass")

    def _cart_prioritization(self, state: V2SessionState, text: str) -> PolicyDecision:
        """Active cart + checkout intent beats new product search."""
        if not state.cart:
            return PolicyDecision(policy_id="cart_skip")

        if _CHECKOUT.search(text):
            return PolicyDecision(policy_id="cart_skip")

        if _CART_ADD.search(text) or extract_isbn_candidate(text):
            return PolicyDecision(policy_id="cart_skip")

        if (
            state.conversation_stage in (
                ConversationStage.CART_REVIEW.value,
                ConversationStage.EMAIL_CAPTURE.value,
                ConversationStage.EMAIL_CONFIRM.value,
                ConversationStage.PAYMENT.value,
            )
        ):
            return PolicyDecision(policy_id="cart_skip")

        if _PRODUCT_SEARCH.search(text) and not _ORDER_INTENT.search(text):
            titles = ", ".join(
                f"{i.get('title', 'item')}" for i in state.cart[:3]
            )
            return PolicyDecision(
                overridden=True,
                plan=Plan(
                    action=PlanAction.SPEAK,
                    response_mode=ResponseMode.INSTANT,
                    instant_text=(
                        f"You already have items in your cart: {titles}. "
                        "Would you like to check out, or add something else?"
                    ),
                    reason="policy_cart_prioritize",
                    stage_hint=ConversationStage.CART_REVIEW.value,
                ),
                commit_patches={"conversation_stage": ConversationStage.CART_REVIEW.value},
                reason="policy_cart_prioritize",
                policy_id="cart_prioritize",
            )

        return PolicyDecision(policy_id="cart_skip")

    def _payment_gating(self, state: V2SessionState, text: str) -> PolicyDecision:
        """Block payment tools without confirmed email + non-empty cart."""
        wants_payment = (
            _CHECKOUT.search(text)
            or state.conversation_stage == ConversationStage.PAYMENT.value
        )
        if not wants_payment:
            return PolicyDecision(policy_id="payment_skip")

        if not state.cart:
            return PolicyDecision(
                overridden=True,
                plan=Plan(
                    action=PlanAction.SPEAK,
                    response_mode=ResponseMode.INSTANT,
                    instant_text="Your cart is empty. Tell me an ISBN or title to add a book first.",
                    reason="policy_payment_no_cart",
                    stage_hint=ConversationStage.SHOPPING.value,
                ),
                commit_patches={"conversation_stage": ConversationStage.SHOPPING.value},
                reason="policy_payment_no_cart",
                policy_id="payment_no_cart",
            )

        if not state.email.confirmed:
            return PolicyDecision(
                overridden=True,
                plan=Plan(
                    action=PlanAction.SPEAK,
                    response_mode=ResponseMode.INSTANT,
                    instant_text="Before I send a payment link, what email should I use?",
                    reason="policy_payment_need_email",
                    stage_hint=ConversationStage.EMAIL_CAPTURE.value,
                ),
                commit_patches={"conversation_stage": ConversationStage.EMAIL_CAPTURE.value},
                reason="policy_payment_need_email",
                policy_id="payment_need_email",
            )

        if state.conversation_stage != ConversationStage.PAYMENT.value:
            return PolicyDecision(
                overridden=True,
                plan=Plan(
                    action=PlanAction.TOOL,
                    tool="send_payment_link",
                    args={},
                    response_mode=ResponseMode.TOOL_RESULT,
                    reason="policy_payment_ready",
                    stage_hint=ConversationStage.PAYMENT.value,
                ),
                commit_patches={"conversation_stage": ConversationStage.PAYMENT.value},
                reason="policy_payment_ready",
                policy_id="payment_ready",
            )

        return PolicyDecision(policy_id="payment_skip")

    def _email_enforcement(self, state: V2SessionState, text: str) -> PolicyDecision:
        """Email capture stages require confirmation before payment."""
        stage = state.conversation_stage

        if stage == ConversationStage.EMAIL_CONFIRM.value and state.email.pending:
            if _YES.match(text):
                return PolicyDecision(
                    overridden=True,
                    plan=Plan(
                        action=PlanAction.TOOL,
                        tool="send_payment_link",
                        args={},
                        response_mode=ResponseMode.TOOL_RESULT,
                        reason="policy_email_confirmed_pay",
                        stage_hint=ConversationStage.PAYMENT.value,
                    ),
                    commit_patches={
                        "conversation_stage": ConversationStage.PAYMENT.value,
                        "email": {
                            "confirmed": state.email.pending,
                            "pending": "",
                            "awaiting_confirmation": False,
                        },
                    },
                    reason="policy_email_confirmed",
                    policy_id="email_confirmed",
                )
            if _NO.match(text):
                return PolicyDecision(
                    overridden=True,
                    plan=Plan(
                        action=PlanAction.SPEAK,
                        response_mode=ResponseMode.INSTANT,
                        instant_text="No problem. What's the correct email address?",
                        reason="policy_email_rejected",
                        stage_hint=ConversationStage.EMAIL_CAPTURE.value,
                    ),
                    commit_patches={
                        "conversation_stage": ConversationStage.EMAIL_CAPTURE.value,
                        "email": {"pending": "", "awaiting_confirmation": False},
                    },
                    reason="policy_email_rejected",
                    policy_id="email_rejected",
                )

        return PolicyDecision(policy_id="email_skip")

    def _email_capture(self, state: V2SessionState, text: str) -> PolicyDecision:
        from .rules import _normalize_email

        stage = state.conversation_stage
        if stage not in (
            ConversationStage.EMAIL_CAPTURE.value,
            ConversationStage.CART_REVIEW.value,
        ):
            return PolicyDecision(policy_id="email_capture_skip")

        email = _normalize_email(text)
        if not email:
            return PolicyDecision(policy_id="email_capture_skip")

        spoken = email.replace("@", " at ")
        return PolicyDecision(
            overridden=True,
            plan=Plan(
                action=PlanAction.SPEAK,
                response_mode=ResponseMode.INSTANT,
                instant_text=f"I have {spoken}. Is that correct?",
                reason="policy_email_capture",
                stage_hint=ConversationStage.EMAIL_CONFIRM.value,
            ),
            commit_patches={
                "conversation_stage": ConversationStage.EMAIL_CONFIRM.value,
                "email": {"pending": email, "awaiting_confirmation": True},
            },
            reason="policy_email_capture",
            policy_id="email_capture",
        )

    def _order_lookup_validation(self, state: V2SessionState, text: str) -> PolicyDecision:
        """Order tools require a spoken order number on this turn."""
        if not _ORDER_INTENT.search(text) and state.conversation_stage != ConversationStage.ORDER_LOOKUP.value:
            return PolicyDecision(policy_id="order_skip")

        m = _ORDER_NUM.search(text)
        if m:
            num = m.group(1)
            return PolicyDecision(
                overridden=True,
                plan=Plan(
                    action=PlanAction.TOOL,
                    tool="lookup_shopify_order_details",
                    args={"order_number": num},
                    response_mode=ResponseMode.TOOL_RESULT,
                    reason="policy_order_validated",
                    stage_hint=ConversationStage.ORDER_LOOKUP.value,
                ),
                commit_patches={
                    "conversation_stage": ConversationStage.ORDER_LOOKUP.value,
                    "order_context": {"last_number": num},
                },
                reason="policy_order_validated",
                policy_id="order_validated",
            )

        if _ORDER_INTENT.search(text):
            return PolicyDecision(
                overridden=True,
                plan=Plan(
                    action=PlanAction.SPEAK,
                    response_mode=ResponseMode.INSTANT,
                    instant_text="Sure — what's your order number?",
                    reason="policy_order_number_required",
                    stage_hint=ConversationStage.ORDER_LOOKUP.value,
                ),
                commit_patches={"conversation_stage": ConversationStage.ORDER_LOOKUP.value},
                reason="policy_order_number_required",
                policy_id="order_number_required",
            )

        return PolicyDecision(policy_id="order_skip")

    def gate_tool_plan(self, state: V2SessionState, plan: Plan) -> PolicyDecision:
        """Final gate on planner-produced tool plans before execution."""
        if plan.action != PlanAction.TOOL:
            return PolicyDecision(policy_id="tool_gate_skip")

        if plan.tool == "send_payment_link":
            if not state.cart:
                return PolicyDecision(
                    overridden=True,
                    plan=Plan(
                        action=PlanAction.SPEAK,
                        response_mode=ResponseMode.INSTANT,
                        instant_text="There's nothing in your cart yet.",
                        reason="policy_gate_payment_no_cart",
                    ),
                    reason="policy_gate_payment_no_cart",
                    policy_id="gate_payment_no_cart",
                )
            if not state.email.confirmed:
                return PolicyDecision(
                    overridden=True,
                    plan=Plan(
                        action=PlanAction.SPEAK,
                        response_mode=ResponseMode.INSTANT,
                        instant_text="I need a confirmed email before sending the payment link.",
                        reason="policy_gate_payment_no_email",
                        stage_hint=ConversationStage.EMAIL_CAPTURE.value,
                    ),
                    commit_patches={"conversation_stage": ConversationStage.EMAIL_CAPTURE.value},
                    reason="policy_gate_payment_no_email",
                    policy_id="gate_payment_no_email",
                )

        if plan.tool == "lookup_shopify_order_details":
            onum = str(plan.args.get("order_number", "") or "")
            if not onum or len(onum) < 4:
                return PolicyDecision(
                    overridden=True,
                    plan=Plan(
                        action=PlanAction.SPEAK,
                        response_mode=ResponseMode.INSTANT,
                        instant_text="Please tell me your order number.",
                        reason="policy_gate_order_invalid",
                    ),
                    reason="policy_gate_order_invalid",
                    policy_id="gate_order_invalid",
                )

        return PolicyDecision(policy_id="tool_gate_pass")
