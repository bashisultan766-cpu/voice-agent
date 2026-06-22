"""
ResponsePlanWorker — deterministic voice response planner (Wave 2).

v4.3: integrates DialogueManager decisions, cart memory, sales flow, payment.
Never calls OpenAI. Never raises.
"""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Optional

from ..cart.session import get_ledger
from ..dialogue.manager import DialogueManager
from ..dialogue.naturalness import NaturalnessController
from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState
    from .base import WorkerBundle

logger = logging.getLogger(__name__)

_VAGUE_CLARIFY = (
    "Sure, I can help with that. Do you have the ISBN, the title, "
    "the author, or just the subject you are looking for?"
)


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
        intent = entities.get("intent", "")
        pfs = getattr(session, "payment_flow_status", "idle") or "idle"
        isbn_buf = getattr(session, "isbn_buffer", "") or ""

        if intent == "greeting":
            from ..dialogue.greeting import build_first_response_greeting
            greeted = getattr(session, "twiml_greeting_spoken", False)
            if (
                getattr(session, "resume_greeting_pending", False)
                and not getattr(session, "resume_greeting_delivered", False)
            ):
                say = getattr(session, "resume_greeting", "") or (
                    "I'm sorry about that. Let me continue from where we left off."
                )
            else:
                say = build_first_response_greeting(session, greeted)
            return {"action": "greet", "say": say}

        # v4.9 small talk intents
        if intent in (
            "small_talk", "identity_question", "agent_name_question",
            "store_info_question", "company_origin_question",
            "keepalive_question", "small_talk_keepalive", "frustration_repair",
        ):
            if bundle:
                st = bundle.results.get("small_talk")
                if st and st.safe_summary:
                    return {"action": "small_talk", "say": st.safe_summary}
            from ..brain.eric_policy import get_small_talk_response
            say = get_small_talk_response(intent, session) or ""
            return {"action": "small_talk", "say": say}

        # v4.9: email readback
        if intent == "email_provided":
            conf = getattr(session, "email_confidence", "medium") or "medium"
            if conf == "low":
                return {
                    "action": "spell_email",
                    "say": "I may have heard that wrong. Please spell the email slowly.",
                }
            from ..pipeline.email_speller import build_email_readback
            email = getattr(session, "pending_email", "") or entities.get("email", "")
            if email:
                return {"action": "confirm_email", "say": build_email_readback(email)}

        # ── v4.4: PaymentFlowWorker result (highest priority) ──────────────────
        if bundle:
            pf = bundle.results.get("payment_flow")
            if pf and pf.data and pf.data.get("ran"):
                data = pf.data
                msg = data.get("safe_message") or pf.safe_summary or ""
                if data.get("email_sent"):
                    action = "payment_sent"
                elif data.get("missing_fields"):
                    action = "payment_blocked"
                elif data.get("stage") == "already_sent":
                    action = "payment_already_sent"
                else:
                    action = "payment_flow"
                return {
                    "action": action,
                    "say": msg,
                    "payment_flow": data,
                }

        # ── Dialogue decision hints (v4.3) ─────────────────────────────────────
        ddec = getattr(session, "last_dialogue_decision", None)
        if ddec and getattr(ddec, "should_clarify", False) and ddec.clarification_prompt:
            return {
                "action": "clarify",
                "say": ddec.clarification_prompt,
            }

        if intent == "vague_book_request":
            return {"action": "clarify_vague_book", "say": _VAGUE_CLARIFY}

        if intent == "isbn_collection_start":
            return {
                "action": "ask_isbn",
                "say": "Sure. Please read the ISBN slowly.",
            }

        if intent == "title_collection_start":
            return {"action": "ask_title", "say": "Sure. What is the title?"}

        if intent == "another_book":
            return {
                "action": "ask_next_book",
                "say": "Sure. Do you have the next ISBN or title?",
            }

        # ── Memory answers ─────────────────────────────────────────────────────
        if bundle:
            r = bundle.results.get("cart_memory")
            if r and r.safe_summary:
                return {"action": "answer_memory", "say": r.safe_summary}

            r = bundle.results.get("spell_email")
            if r and r.safe_summary:
                return {"action": "spell_email", "say": r.safe_summary}

            r = bundle.results.get("cart_mutation")
            if r and r.safe_summary:
                action = (r.data or {}).get("action", "cart_mutation")
                return {"action": action, "say": r.safe_summary}

            r = bundle.results.get("store_info")
            if r and r.safe_summary:
                return {"action": "store_info", "say": r.safe_summary}

            r = bundle.results.get("dialogue")
            if r and r.success and r.safe_summary:
                return {"action": "cart_confirmed", "say": r.safe_summary}

            r = bundle.results.get("payment_flow")
            if r and r.safe_summary:
                return {
                    "action": "payment_result",
                    "success": r.success,
                    "say": r.safe_summary,
                }

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
            conf = getattr(session, "email_confidence", "medium")
            say = f"Just to confirm, I have {masked}. Is that correct?"
            if conf == "low":
                say = (
                    f"I heard {masked}, but I want to make sure I got it right. "
                    "Could you spell the email again slowly?"
                )
            return {
                "action": "confirm_email",
                "masked_email": masked,
                "say": say,
            }

        if pfs == "awaiting_send_confirmation":
            ledger = get_ledger(session)
            n = ledger.confirmed_count() or ledger.count()
            masked = _mask_email(getattr(session, "confirmed_email", ""))
            return {
                "action": "ask_send_confirmation",
                "say": (
                    f"I have {n} book{'s' if n != 1 else ''} ready for {masked}. "
                    "Should I send the payment link now?"
                ),
            }

        # ── Worker bundle results ──────────────────────────────────────────────
        if bundle:
            r = bundle.results.get("isbn_fragment")
            if r and r.success and r.data:
                action = r.data.get("action", "")
                if action in ("accumulating", "awaiting_more"):
                    return {
                        "action": "ask_continue_isbn",
                        "say": r.safe_summary or "Please continue with the next digits.",
                    }

            for wname in ("product_isbn", "product_search"):
                r = bundle.results.get(wname)
                if not r:
                    continue
                isbn = (r.data or {}).get("isbn") or entities.get("isbn", "")
                if r.success and r.data and r.data.get("results") == []:
                    if isbn:
                        DialogueManager.apply_product_not_found(session, isbn)
                    return {
                        "action": "product_not_found",
                        "isbn": isbn,
                        "say": r.safe_summary or f"I could not find a match for ISBN {isbn}.",
                    }
                if r.success and r.safe_summary and not r.data.get("title"):
                    if "No products found" in (r.safe_summary or ""):
                        if isbn:
                            DialogueManager.apply_product_not_found(session, isbn)
                        return {"action": "product_not_found", "say": r.safe_summary}
                    return {
                        "action": "confirm_product",
                        "safe_summary": r.safe_summary,
                        "say": r.safe_summary,
                    }
                if r.success and r.data and r.data.get("title"):
                    data = r.data
                    title = data.get("title", "")
                    price = data.get("price")
                    avail = data.get("available", True)
                    DialogueManager.apply_product_found(
                        session,
                        title=title,
                        isbn=data.get("isbn", isbn),
                        variant_id=data.get("variant_id", ""),
                        price=str(price) if price else None,
                        available=bool(avail),
                    )
                    price_bit = f" The price is ${price}." if price and price != "N/A" else ""
                    if not avail:
                        price_bit = " It may not be in stock right now."
                    return {
                        "action": "confirm_add_book",
                        "say": (
                            f"I found {title}.{price_bit} Would you like to add this book?"
                        ),
                    }

            r = bundle.results.get("order_lookup")
            if r and r.success and r.safe_summary:
                return {"action": "order_status", "safe_summary": r.safe_summary, "say": r.safe_summary}

            r = bundle.results.get("refund")
            if r and r.success and r.safe_summary:
                return {"action": "refund_status", "safe_summary": r.safe_summary, "say": r.safe_summary}

            r = bundle.results.get("facility_approval")
            if r and r.success and r.safe_summary:
                return {"action": "facility_approval", "safe_summary": r.safe_summary, "say": r.safe_summary}

            r = bundle.results.get("facility_restriction")
            if r and r.success and r.safe_summary:
                return {"action": "facility_restrictions", "safe_summary": r.safe_summary, "say": r.safe_summary}

            r = bundle.results.get("address_update")
            if r and r.success and r.safe_summary:
                return {"action": "address_update_instructions", "say": r.safe_summary}

            r = bundle.results.get("cancellation")
            if r and r.success and r.safe_summary:
                return {"action": "cancellation_result", "say": r.safe_summary}

            r = bundle.results.get("escalation")
            if r and r.success and r.safe_summary:
                return {"action": "escalate", "say": r.safe_summary}

            r = bundle.results.get("payment_safety")
            if r and not r.success and r.error_code == "missing_fields":
                missing = r.data.get("missing", []) if r.data else []
                if "book" in missing:
                    return {
                        "action": "ask_missing_payment_field",
                        "missing": missing,
                        "say": "Which book would you like to buy?",
                    }
                if "confirmed_email" in missing:
                    pending = getattr(session, "pending_email", "")
                    if pending:
                        return {
                            "action": "confirm_email",
                            "say": f"Just to confirm, I heard {_mask_email(pending)}. Is that correct?",
                        }
                    return {
                        "action": "ask_email",
                        "say": "What email should I send the payment link to?",
                    }

            r = bundle.results.get("price_inventory")
            if r and not r.success and r.error_code == "no_product_id":
                return {
                    "action": "ask_which_book_price",
                    "say": "Which book would you like the price for?",
                }
            if r and r.success and r.safe_summary:
                return {"action": "price_answer", "say": r.safe_summary}

        state = DialogueManager.get_state(session)
        if state.customer_mood == "frustrated":
            repair = NaturalnessController.frustration_repair_message(session)
            return {
                "action": "apologize_guide",
                "say": repair if NaturalnessController.detect_already_gave(
                    entities.get("raw_text", "")
                ) else (
                    "I'm sorry about the trouble. Let me help you step by step. "
                    + (state.unresolved_question or "What would you like to do next?")
                ),
            }

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
