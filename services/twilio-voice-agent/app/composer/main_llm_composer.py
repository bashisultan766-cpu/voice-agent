"""
MainLLMComposer — the single point that calls OpenAI.

Architecture rule:
  Only this module may import openai or call the OpenAI API.
  Workers (app.workers.*) are deterministic Python code that fetch data.
  The composer receives a WorkerBundle and writes one short voice response.

One OpenAI call per turn:
  - No tool_choice, no TOOL_SCHEMAS passed → LLM produces text only.
  - No iteration loop (unlike openai_agent.py).
  - Streams tokens for low-latency Twilio ConversationRelay delivery.

Safety rules enforced here:
  - Never invent product availability, order status, refund amounts, or prices.
  - WorkerBundle.to_llm_context() gates sensitive data behind verification.
  - System prompt warns: only say what workers confirm.
  - Full email never included even after verification — masked form only.
  - No raw Shopify JSON, GIDs, or payment card data passed to LLM.
"""
from __future__ import annotations

import asyncio
import logging
from typing import AsyncGenerator, Any, Optional, TYPE_CHECKING

from openai import AsyncOpenAI

from ..config import get_settings
from ..state.models import SessionState
from ..ai.system_prompt import build_system_message
from ..cart.session import get_ledger
from ..dialogue.manager import DialogueManager
from ..dialogue.naturalness import NaturalnessController
from ..dialogue.greeting import build_first_response_greeting
from ..domain.sureshot_brain import build_domain_excerpt
from ..safety.response_sanitizer import sanitize_customer_response
from ..conversation.call_memory import (
    build_composer_context,
    record_assistant_turn,
    record_user_turn,
    sync_from_session,
)

if TYPE_CHECKING:
    from ..state.models import SafeCallerContext
    from ..pipeline.router import IntentResult
    from ..workers.base import WorkerBundle

logger = logging.getLogger(__name__)

_MAX_HISTORY = 20
_COMPOSER_SYSTEM_SUFFIX = """
IMPORTANT — COMPOSER RULES (override everything else):
- Worker data below is the ONLY source of facts for this response.
- Use the Response Plan as the source of truth. If the plan asks a clarification question, ask that one question only.
- Do not search, list random products, or invent alternatives when the plan says to clarify.
- Do not answer a different topic than the plan specifies.
- If a worker result is marked "requires verification", do NOT reveal details.
- Never invent prices, availability, order status, refund amounts, or shipping times.
- If workers returned no data or failed, apologise briefly and offer alternatives.
- Keep the response under the word limit. This is a phone call.
- Do not mention "workers", "tools", "cache", "backend", "JSON", or any internal system names.
- Speak naturally, as if you personally looked it up.
- NEVER call any tools. You do not have tool access in this mode.
- If a Response Plan is provided, follow it exactly for this turn — use the "say" text as your guide.
- If payment_flow_result says email_sent=false, MUST NOT say payment was sent.
- If payment_flow_result.safe_message exists, prioritize it exactly.
- Do not repeat the same stock phrase ("Let me check", "Just to confirm") if already used recently.
- When the customer seems frustrated, apologise and guide step by step.
- If cart already has books, do not ask for ISBN again.
- If customer says they already gave ISBN, summarize known ISBNs and cart.
- For email spell requests, use the exact letter-by-letter spelling provided in context.
- Never say payment was sent unless payment_flow_result email_sent=true.
"""


def _deterministic_response(
    session: SessionState,
    router_result: "IntentResult",
) -> str | None:
    """
    Return exact voice text when workers/plan already determined the reply.
    Skips OpenAI for greeting, spell email, and high-priority safe messages.
    """
    plan = getattr(session, "response_plan", {}) or {}
    action = plan.get("action", "")
    say = (plan.get("say") or "").strip()

    pfr = getattr(session, "payment_flow_result", {}) or {}
    if pfr.get("safe_message") and pfr.get("ran"):
        return str(pfr["safe_message"]).strip()

    if router_result.intent == "greeting":
        greeted = getattr(session, "twiml_greeting_spoken", False)
        if getattr(session, "is_resumed_call", False):
            resume_msg = getattr(session, "resume_greeting", None)
            if resume_msg:
                return resume_msg
        return build_first_response_greeting(session, greeted)

    if action == "greet" and say:
        return say

    if action == "greeting" and say:
        return say

    if action in ("spell_email", "answer_memory", "store_info") and say:
        return say

    if action in (
        "payment_blocked", "payment_sent", "payment_already_sent",
        "payment_flow", "ask_send_confirmation", "confirm_email",
    ) and say:
        return say

    if router_result.intent == "ending_thanks":
        return (
            "You're welcome. Thank you for calling SureShot Books. Have a great day."
        )

    if action == "ending_thanks" and say:
        return say

    if router_result.intent == "spell_email_request" and say:
        return say

    return None


def _sanitize_and_finalize(
    text: str,
    session: SessionState,
    router_result: "IntentResult",
) -> str:
    pfr = getattr(session, "payment_flow_result", {}) or {}
    payment_sent = bool(pfr.get("email_sent"))
    result = sanitize_customer_response(
        text,
        intent=router_result.intent,
        call_sid=session.call_sid,
        payment_sent=payment_sent,
    )
    return result.text


def _trim_history(history: list[dict]) -> list[dict]:
    system = [m for m in history if m.get("role") == "system"]
    other = [m for m in history if m.get("role") != "system"]
    if len(other) > _MAX_HISTORY:
        other = other[-_MAX_HISTORY:]
    return system + other


def _build_user_message(
    caller_text: str,
    router_result: "IntentResult",
    worker_bundle: "WorkerBundle",
    session: SessionState,
) -> str:
    """
    Build the user turn message that includes router context and worker data.

    Keeps everything compact and safe — no raw Shopify JSON, no full emails.
    Includes response_plan hint if ResponsePlanWorker produced one.
    """
    parts: list[str] = []

    # Router context (intent + entities — already sanitised)
    if router_result.intent != "unknown":
        intent_human = router_result.intent.replace("_", " ")
        parts.append(f"[Detected intent: {intent_human}]")
        e = router_result.entities
        if e.get("isbn"):
            parts.append(f"[ISBN: {e['isbn']}]")
        if e.get("order_number"):
            parts.append(f"[Order number: {e['order_number']}]")
        if e.get("product_phrase"):
            parts.append(f"[Search phrase: {e['product_phrase'][:60]}]")
        if e.get("quantity"):
            parts.append(f"[Quantity: {e['quantity']}]")

    # v4.3: Dialogue + memory context
    state = DialogueManager.get_state(session)
    if state.active_flow and state.active_flow != "idle":
        parts.append(f"[Active flow: {state.active_flow}]")
    if state.expected_next:
        parts.append(f"[Expected next: {state.expected_next}]")

    ledger = get_ledger(session)
    if ledger.confirmed_count():
        parts.append(f"[Cart: {ledger.confirmed_count()} confirmed book(s)]")
    isbn_n = len(getattr(session, "isbn_history", []) or [])
    if isbn_n:
        parts.append(f"[ISBNs given this call: {isbn_n}]")

    pfs = getattr(session, "payment_flow_status", "idle") or "idle"
    if pfs != "idle":
        parts.append(f"[Payment stage: {pfs}]")
    if getattr(session, "pending_email", ""):
        try:
            from ..caller.repository import mask_email
            parts.append(f"[Pending email: {mask_email(session.pending_email)}]")
        except Exception:
            parts.append("[Pending email: on file]")
    if getattr(session, "confirmed_email", ""):
        try:
            from ..caller.repository import mask_email
            parts.append(f"[Confirmed email: {mask_email(session.confirmed_email)}]")
        except Exception:
            parts.append("[Confirmed email: on file]")

    if state.last_product_candidate.get("title"):
        parts.append(f"[Last book discussed: {state.last_product_candidate['title'][:60]}]")
    if session.last_order_number:
        parts.append(f"[Last order: {session.last_order_number}]")

    if state.customer_mood == "frustrated":
        parts.append("[Customer mood: frustrated — be patient and guide step by step]")

    from ..dialogue.naturalness import NaturalnessController
    style = NaturalnessController.style_hint(session)
    if style:
        parts.append(f"[Response style: {style}]")
    rep = NaturalnessController.avoid_repetition_note(session)
    if rep:
        parts.append(f"[{rep}]")

    domain_ctx = build_domain_excerpt(session, caller_text, router_result.intent)
    if domain_ctx:
        parts.append(f"[SureShot domain: {domain_ctx}]")

    memory_ctx = build_composer_context(session)
    if memory_ctx:
        parts.append(memory_ctx)

    pfr = getattr(session, "payment_flow_result", {}) or {}
    if pfr.get("ran"):
        parts.append(
            f"[Payment flow: stage={pfr.get('stage')} allowed={pfr.get('allowed')} "
            f"email_sent={pfr.get('email_sent')} missing={pfr.get('missing_fields')}]"
        )
        if pfr.get("safe_message"):
            parts.append(f"[Payment message — say this: {pfr.get('safe_message')}]")

    # v4.2: Response plan from ResponsePlanWorker
    plan = getattr(session, "response_plan", {}) or {}
    plan_say = plan.get("say", "") if plan else ""
    plan_action = plan.get("action", "") if plan else ""
    if plan_action and plan_action not in ("clarify", ""):
        if plan_say:
            parts.append(f"[Response Plan — say this: {plan_say}]")
        else:
            parts.append(f"[Response Plan — action: {plan_action}]")

    # Worker data (gated by verification)
    worker_ctx = worker_bundle.to_llm_context(
        verified_email=session.verified_email,
        verified_phone=session.verified_phone,
    )
    parts.append(worker_ctx)

    # Caller utterance
    parts.append(f"Caller says: {caller_text}")

    return "\n".join(parts)


class MainLLMComposer:
    """
    Composes one short voice response from worker data.

    This is the ONLY component allowed to call OpenAI.
    """

    def __init__(self, settings=None):
        self._settings = settings or get_settings()

    async def stream_response(
        self,
        session: SessionState,
        caller_text: str,
        router_result: "IntentResult",
        worker_bundle: "WorkerBundle",
        caller_context: Optional["SafeCallerContext"],
        settings=None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """
        Async generator that yields text_token and turn_done events.

        Makes exactly ONE OpenAI call per invocation. No tool loop.
        """
        s = settings or self._settings

        record_user_turn(session, caller_text, router_result.intent)
        sync_from_session(session)

        deterministic = _deterministic_response(session, router_result)
        if deterministic:
            deterministic = _sanitize_and_finalize(deterministic, session, router_result)
            session.turn_count += 1
            session.history.append({"role": "user", "content": caller_text})
            session.history.append({"role": "assistant", "content": deterministic})
            NaturalnessController.record_response(session, deterministic)
            record_assistant_turn(session, deterministic)
            yield {"type": "text_token", "token": deterministic}
            yield {"type": "turn_done"}
            return

        client = AsyncOpenAI(api_key=s.OPENAI_API_KEY)

        # Build/reuse system message
        if not session.history or session.history[0].get("role") != "system":
            sys_msg = build_system_message(
                store_domain=session.store_domain,
                caller_context=caller_context,
                max_reply_words=s.VOICE_MAX_REPLY_WORDS,
                live_composer=True,
            )
            # Append composer suffix to system content
            sys_msg = {
                "role": "system",
                "content": sys_msg["content"] + "\n" + _COMPOSER_SYSTEM_SUFFIX.strip(),
            }
            session.history.insert(0, sys_msg)
        elif caller_context is not None and session.turn_count == 0:
            # Update system message on first turn if we have fresh caller context
            sys_msg = build_system_message(
                store_domain=session.store_domain,
                caller_context=caller_context,
                max_reply_words=s.VOICE_MAX_REPLY_WORDS,
                live_composer=True,
            )
            session.history[0] = {
                "role": "system",
                "content": sys_msg["content"] + "\n" + _COMPOSER_SYSTEM_SUFFIX.strip(),
            }

        # Append enriched user message (not stored in history as-is)
        user_content = _build_user_message(caller_text, router_result, worker_bundle, session)

        messages = _trim_history(session.history)
        # Append enriched user message just for this call (not stored in history yet)
        messages = messages + [{"role": "user", "content": user_content}]

        session.turn_count += 1

        text_tokens: list[str] = []
        try:
            # NO tools= parameter → LLM produces text only, guaranteed single iteration.
            stream = await client.chat.completions.create(
                model=s.OPENAI_MODEL,
                messages=messages,
                stream=True,
                max_tokens=150,  # ~50 words; short voice response
                temperature=0.6,
                timeout=s.VOICE_OPENAI_TIMEOUT_MS / 1000,
            )

            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta.content:
                    text_tokens.append(delta.content)

        except asyncio.CancelledError:
            logger.info("Composer turn cancelled (interrupt) sid=%s", session.call_sid[:6])
            return
        except Exception as exc:
            logger.exception("Composer OpenAI error sid=%s: %s", session.call_sid[:6], exc)
            err = _sanitize_and_finalize(
                "I'm sorry, I had a technical problem. Could you repeat that?",
                session, router_result,
            )
            yield {"type": "text_token", "token": err}
            yield {"type": "turn_done"}
            return

        # Store the response in history so the conversation stays coherent
        response_text = "".join(text_tokens)
        if response_text:
            response_text = _sanitize_and_finalize(response_text, session, router_result)
            session.history.append({"role": "user", "content": caller_text})
            session.history.append({"role": "assistant", "content": response_text})
            NaturalnessController.record_response(session, response_text)
            record_assistant_turn(session, response_text)
            yield {"type": "text_token", "token": response_text}

        yield {"type": "turn_done"}


_composer: MainLLMComposer | None = None


def get_composer(settings=None) -> MainLLMComposer:
    global _composer
    if _composer is None:
        _composer = MainLLMComposer(settings=settings)
    return _composer
