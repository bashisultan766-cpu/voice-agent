"""
PaymentFlowWorker — end-to-end payment orchestration (v4.4).

ALWAYS runs for send_payment_link, payment_execute, checkout_request,
payment_status_question. Produces structured PaymentFlowResult on session.

Never calls OpenAI.
"""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Any

from ..cart.payment_scope import resolve_payment_scope
from ..cart.recovery import attempt_cart_recovery
from ..payment.flow_result import PaymentFlowResult
from .base import WorkerResult
from .checkout_worker import CheckoutWorker
from .payment_email_worker import PaymentEmailWorker

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

PAYMENT_INTENTS = frozenset({
    "send_payment_link",
    "payment_execute",
    "checkout_request",
    "payment_status_question",
})


def _mask_email(email: str) -> str:
    try:
        from ..caller.repository import mask_email
        return mask_email(email)
    except Exception:
        if "@" in email:
            local, domain = email.split("@", 1)
            return local[:1] + "***@" + domain
        return "***"


def _log_decision(intent: str, flow: PaymentFlowResult, sid: str) -> None:
    logger.info(
        "payment_flow_decision intent=%s stage=%s allowed=%s missing=%s "
        "cart_count=%d email=%s sid=%s",
        intent,
        flow.stage,
        flow.allowed,
        flow.missing_fields,
        flow.cart_count,
        flow.masked_email or "***",
        sid[:6],
    )


class PaymentFlowWorker:
    name = "payment_flow"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        t0 = time.monotonic()
        intent = entities.get("intent", "")
        raw_text = entities.get("raw_text", "")
        sid = session.call_sid[:6]
        pfs = getattr(session, "payment_flow_status", "idle") or "idle"

        flow = PaymentFlowResult(ran=True)
        flow.masked_email = _mask_email(getattr(session, "confirmed_email", "") or "")

        # ── Payment status question ────────────────────────────────────────────
        if intent == "payment_status_question":
            return self._handle_status_question(session, flow, t0)

        scoped, scope_msg = resolve_payment_scope(session, entities, raw_text)
        flow.cart_count = len(scoped)

        if not scoped and intent in PAYMENT_INTENTS:
            recovery = await attempt_cart_recovery(session, raw_text, settings)
            if recovery.success:
                scoped, scope_msg = resolve_payment_scope(session, entities, raw_text)
                flow.cart_count = len(scoped)

        if scope_msg:
            flow.stage = "scope_clarification"
            flow.allowed = False
            flow.safe_message = scope_msg
            session.payment_flow_result = flow.to_dict()
            _log_decision(intent, flow, sid)
            return self._result(flow, t0, success=False, error_code="scope_ambiguous")

        # ── Already sent ───────────────────────────────────────────────────────
        if pfs == "payment_sent" or getattr(session, "payment_email_sent_to", []):
            flow.stage = "already_sent"
            flow.allowed = False
            flow.email_sent = True
            masked = flow.masked_email or "***"
            flow.safe_message = (
                f"I've already sent the payment link to {masked}. "
                "Please check your inbox and spam folder."
            )
            logger.info("payment_already_sent sid=%s email=%s", sid, masked)
            session.payment_flow_result = flow.to_dict()
            _log_decision(intent, flow, sid)
            return self._result(flow, t0, success=True)

        missing = self._compute_missing(session, scoped)
        flow.missing_fields = missing

        if missing:
            flow.stage = self._missing_stage(missing, session)
            flow.allowed = False
            flow.safe_message = self._missing_message(missing, session)
            session.payment_flow_status = self._pfs_for_missing(missing, session)
            session.payment_flow_result = flow.to_dict()
            session.payment_block_count = getattr(session, "payment_block_count", 0) + 1
            logger.info(
                "payment_missing_fields sid=%s fields=%s",
                sid, missing,
            )
            _log_decision(intent, flow, sid)
            return self._result(flow, t0, success=False, error_code="missing_fields")

        # ── Ready to execute (v4.4: send_payment_link counts as final confirm) ─
        should_execute = intent in ("payment_execute", "send_payment_link", "checkout_request")
        if not should_execute:
            flow.stage = "ready_not_requested"
            flow.allowed = True
            flow.safe_message = (
                f"I have {flow.cart_count} book{'s' if flow.cart_count != 1 else ''} ready. "
                "Should I send the payment link now?"
            )
            session.payment_flow_status = "awaiting_send_confirmation"
            session.payment_flow_result = flow.to_dict()
            _log_decision(intent, flow, sid)
            return self._result(flow, t0, success=True)

        # Stash scoped items for checkout
        session._payment_checkout_items = scoped  # noqa: SLF001 — session-scoped checkout slice

        checkout_created = False
        if not session.pending_checkout_url:
            logger.info("payment_checkout_attempt sid=%s cart_count=%d", sid, flow.cart_count)
            checkout = CheckoutWorker()
            prev_cart = session.cart_items
            session.cart_items = scoped
            try:
                checkout_result = await checkout.run(session, entities, settings)
            finally:
                session.cart_items = prev_cart

            if not checkout_result.success:
                flow.stage = "checkout_error"
                flow.allowed = False
                flow.safe_message = (
                    "I'm having trouble creating the payment link. Let me try one more time."
                )
                session.payment_flow_result = flow.to_dict()
                logger.info("payment_checkout_failure sid=%s err=%s", sid, checkout_result.error_code)
                _log_decision(intent, flow, sid)
                return self._result(flow, t0, success=False, error_code="checkout_failed")

            if checkout_result.data and checkout_result.data.get("checkout_url"):
                session.pending_checkout_url = checkout_result.data["checkout_url"]
                checkout_created = True
                flow.checkout_created = True
                logger.info("payment_checkout_success sid=%s", sid)
        else:
            flow.checkout_created = True
            checkout_created = True

        logger.info("payment_email_attempt sid=%s", sid)
        email_worker = PaymentEmailWorker()
        email_result = await email_worker.run(session, entities, settings)

        if email_result.success:
            flow.stage = "sent"
            flow.allowed = True
            flow.email_sent = True
            flow.checkout_created = checkout_created or bool(session.pending_checkout_url)
            session.payment_flow_status = "payment_sent"
            masked = flow.masked_email or _mask_email(session.confirmed_email)
            flow.safe_message = (
                f"I've sent the payment link to {masked}. "
                "Please check your inbox and spam folder."
            )
            session.payment_flow_result = flow.to_dict()
            logger.info("payment_email_success sid=%s email=%s", sid, masked)
            _log_decision(intent, flow, sid)
            return self._result(flow, t0, success=True, source="resend")

        flow.stage = "email_error"
        flow.allowed = False
        flow.checkout_created = checkout_created
        if session.pending_checkout_url:
            flow.safe_message = (
                "I created the payment link, but I could not send the email right now. "
                "I can try again."
            )
            logger.info("payment_email_failure sid=%s err=%s", sid, email_result.error_code)
        else:
            flow.safe_message = "I could not complete the payment link right now."
        session.payment_flow_result = flow.to_dict()
        _log_decision(intent, flow, sid)
        return self._result(flow, t0, success=False, error_code="email_failed", source="resend")

    def _handle_status_question(
        self,
        session: "SessionState",
        flow: PaymentFlowResult,
        t0: float,
    ) -> WorkerResult:
        sid = session.call_sid[:6]
        pfs = getattr(session, "payment_flow_status", "idle") or "idle"
        if pfs == "payment_sent" or session.payment_email_sent_to:
            flow.stage = "already_sent"
            flow.email_sent = True
            masked = _mask_email(session.confirmed_email)
            flow.safe_message = f"Yes, I sent the payment link to {masked}."
        else:
            missing = self._compute_missing(session, _scoped_items(session))
            flow.missing_fields = missing
            if missing:
                flow.stage = "not_sent_missing"
                flow.safe_message = (
                    "I haven't sent it yet. "
                    + self._missing_message(missing, session)
                )
            else:
                flow.stage = "ready_unsent"
                flow.safe_message = (
                    "I haven't sent it yet. I have everything ready. "
                    "Should I send the payment link now?"
                )
                session.payment_flow_status = "awaiting_send_confirmation"
        session.payment_flow_result = flow.to_dict()
        _log_decision("payment_status_question", flow, sid)
        return self._result(flow, t0, success=True)

    @staticmethod
    def _compute_missing(session: "SessionState", scoped: list) -> list[str]:
        missing: list[str] = []
        if not scoped:
            missing.append("cart_items")
        elif not any(i.get("variant_id") for i in scoped):
            missing.append("variant_id")
        if not getattr(session, "confirmed_email", ""):
            if getattr(session, "pending_email", ""):
                missing.append("email_confirmation")
            else:
                missing.append("confirmed_email")
        return missing

    @staticmethod
    def _missing_stage(missing: list[str], session: "SessionState") -> str:
        if "confirmed_email" in missing:
            return "awaiting_email"
        if "email_confirmation" in missing:
            return "awaiting_email_confirmation"
        if "cart_items" in missing or "variant_id" in missing:
            return "awaiting_cart"
        return "blocked"

    @staticmethod
    def _missing_message(missing: list[str], session: "SessionState") -> str:
        has_email = bool(getattr(session, "confirmed_email", ""))
        isbn_hist = getattr(session, "isbn_history", []) or []

        if "cart_items" in missing or "variant_id" in missing:
            if isbn_hist and not has_email:
                return (
                    "I have the ISBNs you gave me, but I still need to confirm "
                    "the books I found before I can send the link."
                )
            if isbn_hist and has_email:
                return (
                    "I have the ISBNs you gave me, but I still need to confirm "
                    "the books I found before I can send the payment link."
                )
            if has_email:
                return (
                    "I still need to confirm which book or books to include "
                    "before I can send the payment link."
                )
            return (
                "I still need to confirm which book or books to include "
                "before I can send the payment link."
            )
        if "email_confirmation" in missing:
            pending = getattr(session, "pending_email", "")
            return f"Just to confirm, I heard {_mask_email(pending)}. Is that correct?"
        if "confirmed_email" in missing:
            block = getattr(session, "payment_block_count", 0)
            if block >= 1:
                return (
                    "I haven't sent it yet because I still need a confirmed email address. "
                    "What email should I send the payment link to?"
                )
            return "What email should I send the payment link to?"
        return "I still need a few details before I can send the payment link."

    @staticmethod
    def _pfs_for_missing(missing: list[str], session: "SessionState") -> str:
        if "email_confirmation" in missing:
            return "awaiting_email_confirmation"
        if "confirmed_email" in missing:
            return "awaiting_email"
        return getattr(session, "payment_flow_status", "idle") or "idle"

    @staticmethod
    def _result(
        flow: PaymentFlowResult,
        t0: float,
        success: bool,
        error_code: str = "",
        source: str = "local",
    ) -> WorkerResult:
        return WorkerResult(
            worker_name="payment_flow",
            success=success,
            data=flow.to_dict(),
            safe_summary=flow.safe_message,
            error_code=error_code or None,
            latency_ms=(time.monotonic() - t0) * 1000,
            source=source,
        )


def _scoped_items(session: "SessionState") -> list:
    scoped, _ = resolve_payment_scope(session, {}, "")
    return scoped
