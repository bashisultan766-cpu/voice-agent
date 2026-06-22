"""
ResponsePlanWorker — deterministic voice response planner (Wave 2).

Runs after all Wave 1 workers complete. Examines session state and the
WorkerBundle to produce a structured response_plan that the MainLLMComposer
follows. The plan contains an "action" key and an optional "say" hint.

Never calls OpenAI. Never raises.
"""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Optional

from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState
    from .base import WorkerBundle

logger = logging.getLogger(__name__)


class ResponsePlanWorker:
    name = "response_plan"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
        worker_bundle: Optional["WorkerBundle"] = None,
    ) -> WorkerResult:
        t0 = time.monotonic()
        try:
            plan = self._build_plan(session, entities, worker_bundle)
        except Exception:
            logger.exception("ResponsePlanWorker error sid=%s", session.call_sid[:6])
            plan = {"action": "clarify", "say": ""}

        session.response_plan = plan
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data=plan,
            safe_summary=plan.get("say", ""),
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )

    def _build_plan(
        self,
        session: "SessionState",
        entities: dict,
        bundle: Optional["WorkerBundle"],
    ) -> dict:
        pfs = getattr(session, "payment_flow_status", "idle") or "idle"
        isbn_buf = getattr(session, "isbn_buffer", "") or ""

        # ── ISBN in progress ───────────────────────────────────────────────────
        if isbn_buf and len(isbn_buf) < 10:
            return {
                "action": "ask_continue_isbn",
                "digits_so_far": isbn_buf,
                "count": len(isbn_buf),
                "say": f"I have {isbn_buf} so far. Please continue with the next digits.",
            }

        # ── Payment flow state machine ─────────────────────────────────────────
        if pfs == "payment_sent":
            return {
                "action": "payment_sent",
                "say": (
                    "I've already sent the payment link to your email. "
                    "Please check your inbox and spam folder."
                ),
            }

        if pfs == "awaiting_email_confirmation" and getattr(session, "pending_email", ""):
            masked = _mask_email(session.pending_email)
            return {
                "action": "confirm_email",
                "masked_email": masked,
                "say": f"Just to confirm, I have {masked}. Is that correct?",
            }

        if pfs == "awaiting_send_confirmation":
            return {
                "action": "ask_send_confirmation",
                "say": "Great, I have your email confirmed. Shall I send the payment link now?",
            }

        # ── Cart questions ─────────────────────────────────────────────────────
        if entities.get("intent") in ("cart_count_question", "titles_question"):
            cart = getattr(session, "cart_items", []) or []
            active = [c for c in cart if isinstance(c, dict)
                      and c.get("confirmation_status") != "rejected"]
            titles = [c.get("title", "unknown") for c in active if c.get("title")]
            count = len(active)
            title_str = (", ".join(titles[:3]) + ("..." if len(titles) > 3 else "")) if titles else ""
            return {
                "action": "answer_cart_count",
                "count": count,
                "titles": titles,
                "say": (
                    f"You have {count} book{'s' if count != 1 else ''} selected."
                    + (f" {title_str}" if title_str else "")
                ),
            }

        # ── Worker bundle results ──────────────────────────────────────────────
        if bundle:
            # Product found
            for wname in ("product_isbn", "product_search"):
                r = bundle.results.get(wname)
                if r and r.success and r.safe_summary:
                    return {
                        "action": "confirm_product",
                        "safe_summary": r.safe_summary,
                        "say": r.safe_summary,
                    }

            # ISBN fragment accumulating
            r = bundle.results.get("isbn_fragment")
            if r and r.success and r.data:
                action = r.data.get("action", "")
                if action in ("accumulating", "awaiting_more"):
                    return {
                        "action": "ask_continue_isbn",
                        "say": r.safe_summary or "Please continue with the next digits.",
                    }

            # Order found
            r = bundle.results.get("order_lookup")
            if r and r.success and r.safe_summary:
                return {"action": "order_status", "safe_summary": r.safe_summary, "say": r.safe_summary}

            # Refund
            r = bundle.results.get("refund")
            if r and r.success and r.safe_summary:
                return {"action": "refund_status", "safe_summary": r.safe_summary, "say": r.safe_summary}

            # Facility approval
            r = bundle.results.get("facility_approval")
            if r and r.success and r.safe_summary:
                return {"action": "facility_approval", "safe_summary": r.safe_summary, "say": r.safe_summary}

            # Facility restriction
            r = bundle.results.get("facility_restriction")
            if r and r.success and r.safe_summary:
                return {"action": "facility_restrictions", "safe_summary": r.safe_summary, "say": r.safe_summary}

            # Address update
            r = bundle.results.get("address_update")
            if r and r.success and r.safe_summary:
                return {"action": "address_update_instructions", "say": r.safe_summary}

            # Cancellation
            r = bundle.results.get("cancellation")
            if r and r.success and r.safe_summary:
                return {"action": "cancellation_result", "say": r.safe_summary}

            # Escalation
            r = bundle.results.get("escalation")
            if r and r.success and r.safe_summary:
                return {"action": "escalate", "say": r.safe_summary}

            # Payment safety blocked
            r = bundle.results.get("payment_safety")
            if r and not r.success and r.error_code == "missing_fields":
                missing = r.data.get("missing", []) if r.data else []
                if "book" in missing:
                    return {
                        "action": "ask_missing_payment_field",
                        "missing": missing,
                        "say": "Sure, I can send a payment link. Which book would you like to order?",
                    }
                if "confirmed_email" in missing:
                    return {
                        "action": "ask_email",
                        "say": "I can send you a payment link. What email address should I send it to?",
                    }

        # ── No actionable result → let LLM handle naturally ───────────────────
        return {"action": "clarify", "say": ""}


def _mask_email(email: str) -> str:
    try:
        from ..caller.repository import mask_email
        return mask_email(email)
    except Exception:
        if "@" in email:
            local, domain = email.split("@", 1)
            return local[:1] + "***@" + domain
        return "***"
