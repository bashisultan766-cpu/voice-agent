"""
RealtimePipelineEngine — orchestrates per-turn pipeline logic.

v4.2: Single worker→composer path for ALL intents when
VOICE_LIVE_DISABLE_OPENAI_TOOLS=True (default).

WORKER PATH (all intents in v4.2):
  1. Deterministic intent router (regex, no LLM, microseconds)
  2. Email state machine update
  3. Filler phrase sent if workers are slow (VOICE_FILLER_AFTER_MS gate)
  4. WorkerOrchestrator Wave 1: parallel domain workers
     WorkerOrchestrator Wave 2: ResponsePlanWorker builds response_plan
  5. MainLLMComposer: ONE text-only OpenAI call (no tools, no tool_calls)
  6. Stream text tokens → Twilio ConversationRelay

OpenAI never receives tool schemas. session.history never stores
role="tool" or assistant tool_calls. 400 errors on interrupt are eliminated.

LEGACY FALLBACK PATH (only when VOICE_LIVE_DISABLE_OPENAI_TOOLS=False):
  For conversational intents, falls back to run_agent_turn with tool calling.
  Not used in production v4.2+.

Workers never call OpenAI.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable, Optional, TYPE_CHECKING

from ..config import get_settings
from ..state.models import SessionState
from ..ai.openai_agent import run_agent_turn
from .router import detect as detect_intent, IntentResult
from .latency import get_tracer, TurnLatency
from .tasks import filler_for_intent, needs_filler, Intent
from .tool_executor import run_tools_parallel
from ..workers.orchestrator import WorkerOrchestrator, WORKER_PATH_INTENTS, get_orchestrator
from ..composer.main_llm_composer import MainLLMComposer, get_composer

if TYPE_CHECKING:
    from ..state.models import SafeCallerContext

logger = logging.getLogger(__name__)


class RealtimePipelineEngine:
    """
    Orchestrator for one Twilio ConversationRelay turn.

    Uses the fast worker path for tool intents and falls back to the
    existing run_agent_turn path for conversational/unknown intents.
    """

    def __init__(self, settings=None):
        self._settings = settings or get_settings()
        self._tracer = get_tracer()
        self._orchestrator: WorkerOrchestrator = get_orchestrator()
        self._composer: MainLLMComposer = get_composer()

    async def handle_turn(
        self,
        session: SessionState,
        caller_text: str,
        send: Callable[[dict], Awaitable[None]],
        caller_context: Optional["SafeCallerContext"] = None,
    ) -> None:
        """
        Process one caller utterance end-to-end.

        Routes to fast worker→composer path for tool intents; falls back to
        run_agent_turn for conversational intents (greeting, confirmation,
        email_capture, unknown).
        """
        settings = self._settings
        turn = self._tracer.start_turn(session.call_sid)

        # ── 1. Intent detection ────────────────────────────────────────────────
        t0 = time.monotonic()
        intent_result = detect_intent(caller_text, session)
        turn.router_ms = (time.monotonic() - t0) * 1000
        turn.intent = intent_result.intent
        logger.debug(
            "intent=%s conf=%.2f entities=%s sid=%s",
            intent_result.intent,
            intent_result.confidence,
            list(intent_result.entities.keys()),
            session.call_sid[:6],
        )

        # ── 2. Email state machine (always, before path decision) ─────────────
        # Updates session.pending_email / confirmed_email / payment_flow_status
        # and accumulates multi-turn email fragments.
        _apply_email_state(session, intent_result)

        # v4.2: when VOICE_LIVE_DISABLE_OPENAI_TOOLS is True (default), ALL
        # intents use the worker→composer path. run_agent_turn is never called.
        if settings.VOICE_LIVE_DISABLE_OPENAI_TOOLS:
            use_worker_path = True
        else:
            use_worker_path = intent_result.intent in WORKER_PATH_INTENTS

        try:
            if use_worker_path:
                await self._handle_turn_workers(
                    session, caller_text, send, caller_context,
                    intent_result, turn, settings,
                )
            else:
                await self._handle_turn_fallback(
                    session, caller_text, send, caller_context,
                    intent_result, turn, settings,
                )
        finally:
            self._tracer.finish(turn)

    # ── Worker path ────────────────────────────────────────────────────────────

    async def _handle_turn_workers(
        self,
        session: SessionState,
        caller_text: str,
        send: Callable[[dict], Awaitable[None]],
        caller_context: Optional["SafeCallerContext"],
        intent_result: IntentResult,
        turn: TurnLatency,
        settings,
    ) -> None:
        """
        Fast path: parallel workers → single composer LLM call.

        Workers run concurrently. Filler is gated by VOICE_FILLER_AFTER_MS:
        if workers finish before the deadline, filler is skipped (cache hit).
        """
        engine_sent_filler = False
        filler_delay_ms = settings.VOICE_FILLER_AFTER_MS

        # Start workers as a background task so filler logic can race them.
        worker_task = asyncio.create_task(
            self._orchestrator.run(intent_result, session, settings),
            name="pipeline-workers",
        )

        # ── Filler logic ───────────────────────────────────────────────────────
        if intent_result.needs_filler and needs_filler(intent_result.intent):
            filler_text = filler_for_intent(intent_result.intent)
            if filler_text:
                if filler_delay_ms > 0:
                    try:
                        await asyncio.wait_for(
                            asyncio.shield(worker_task),
                            timeout=filler_delay_ms / 1000,
                        )
                        # Workers finished before the deadline — skip filler.
                    except asyncio.TimeoutError:
                        t_f = time.monotonic()
                        await send({
                            "type": "text",
                            "token": filler_text,
                            "last": False,
                            "interruptible": True,
                        })
                        turn.filler_ms = (time.monotonic() - t_f) * 1000
                        engine_sent_filler = True
                else:
                    # Immediate mode (VOICE_FILLER_AFTER_MS=0).
                    t_f = time.monotonic()
                    await send({
                        "type": "text",
                        "token": filler_text,
                        "last": False,
                        "interruptible": True,
                    })
                    turn.filler_ms = (time.monotonic() - t_f) * 1000
                    engine_sent_filler = True

        # ── Await worker results ───────────────────────────────────────────────
        t_w = time.monotonic()
        try:
            worker_bundle = await worker_task
        except asyncio.CancelledError:
            if not worker_task.done():
                worker_task.cancel()
            raise
        except Exception:
            logger.exception("Worker task error sid=%s", session.call_sid[:6])
            from ..workers.base import WorkerBundle
            worker_bundle = WorkerBundle()
        finally:
            turn.tools_ms = (time.monotonic() - t_w) * 1000

        # Propagate per-source latency to TurnLatency.
        turn.shopify_api_ms = worker_bundle.shopify_api_ms
        turn.resend_api_ms = worker_bundle.resend_api_ms

        # ── Composer: ONE OpenAI call ──────────────────────────────────────────
        first_token_time: Optional[float] = None
        try:
            async for event in self._composer.stream_response(
                session, caller_text, intent_result, worker_bundle,
                caller_context, settings,
            ):
                etype = event["type"]
                if etype == "text_token":
                    if first_token_time is None:
                        first_token_time = time.monotonic()
                        turn.openai_first_token_ms = (
                            (first_token_time - turn._start) * 1000
                        )
                    await send({
                        "type": "text",
                        "token": event["token"],
                        "last": False,
                        "interruptible": True,
                    })
                elif etype == "turn_done":
                    await send({"type": "text", "token": "", "last": True})

        except asyncio.CancelledError:
            logger.info("Composer turn cancelled sid=%s", session.call_sid[:6])
            raise
        except Exception:
            logger.exception("Composer error sid=%s", session.call_sid[:6])
            await send({
                "type": "text",
                "token": "Sorry, I ran into an error. Could you try again?",
                "last": False,
                "interruptible": False,
            })
            await send({"type": "text", "token": "", "last": True})

    # ── Fallback path (conversational/unknown) ─────────────────────────────────

    async def _handle_turn_fallback(
        self,
        session: SessionState,
        caller_text: str,
        send: Callable[[dict], Awaitable[None]],
        caller_context: Optional["SafeCallerContext"],
        intent_result: IntentResult,
        turn: TurnLatency,
        settings,
    ) -> None:
        """
        Original path: optional speculative prefetch → run_agent_turn.

        Used for greeting, confirmation, email intents, unknown.
        Preserved for backward compatibility and conversational flexibility.
        """
        # ── Speculative prefetch ───────────────────────────────────────────────
        prefetch_task: Optional[asyncio.Task] = None
        if intent_result.suggested_tools and intent_result.confidence >= 0.8:
            tool_calls = _build_speculative_calls(intent_result, session)
            if tool_calls:
                prefetch_task = asyncio.create_task(
                    self._run_prefetch(turn, tool_calls, session, settings),
                    name="pipeline-prefetch",
                )

        # ── Filler ────────────────────────────────────────────────────────────
        engine_sent_filler = False
        if intent_result.needs_filler and needs_filler(intent_result.intent):
            filler_text = filler_for_intent(intent_result.intent)
            if filler_text:
                filler_delay_ms = settings.VOICE_FILLER_AFTER_MS
                if filler_delay_ms > 0 and prefetch_task is not None:
                    try:
                        await asyncio.wait_for(
                            asyncio.shield(prefetch_task),
                            timeout=filler_delay_ms / 1000,
                        )
                    except asyncio.TimeoutError:
                        t_f = time.monotonic()
                        await send({
                            "type": "text",
                            "token": filler_text,
                            "last": False,
                            "interruptible": True,
                        })
                        turn.filler_ms = (time.monotonic() - t_f) * 1000
                        engine_sent_filler = True
                else:
                    t_f = time.monotonic()
                    await send({
                        "type": "text",
                        "token": filler_text,
                        "last": False,
                        "interruptible": True,
                    })
                    turn.filler_ms = (time.monotonic() - t_f) * 1000
                    engine_sent_filler = True

        # ── run_agent_turn (OpenAI + tools) ───────────────────────────────────
        router_context = _build_router_context(intent_result, session)
        first_token_time: Optional[float] = None

        try:
            async for event in run_agent_turn(
                session, caller_text, settings,
                caller_context=caller_context,
                router_context=router_context,
            ):
                etype = event["type"]

                if etype == "text_token":
                    if first_token_time is None:
                        first_token_time = time.monotonic()
                        turn.openai_first_token_ms = (
                            (first_token_time - turn._start) * 1000
                        )
                    await send({
                        "type": "text",
                        "token": event["token"],
                        "last": False,
                        "interruptible": True,
                    })

                elif etype == "filler":
                    if not engine_sent_filler:
                        await send({
                            "type": "text",
                            "token": event["token"],
                            "last": False,
                            "interruptible": True,
                        })

                elif etype == "turn_done":
                    await send({"type": "text", "token": "", "last": True})

        except asyncio.CancelledError:
            logger.info("Pipeline turn cancelled (interrupt) sid=%s", session.call_sid[:6])
            if prefetch_task and not prefetch_task.done():
                prefetch_task.cancel()
            raise
        except Exception:
            logger.exception("Pipeline turn error sid=%s", session.call_sid[:6])
            await send({
                "type": "text",
                "token": "Sorry, I ran into an error. Could you try again?",
                "last": False,
                "interruptible": False,
            })
            await send({"type": "text", "token": "", "last": True})

    # ── Call setup prefetch ────────────────────────────────────────────────────

    async def prefetch_on_call_setup(self, session: SessionState) -> None:
        """
        Best-effort parallel prefetch at call setup time.

        Checks local Redis caches for customer and recent order data and
        pre-populates session fields. No live Shopify calls are made here —
        cache miss is silent. Never blocks or raises.
        """
        try:
            from ..sync.repositories import CustomerCache, OrderCache
            tasks = [
                asyncio.create_task(
                    _prefetch_customer(session, CustomerCache()),
                    name="setup-prefetch-customer",
                ),
                asyncio.create_task(
                    _prefetch_recent_order(session, OrderCache()),
                    name="setup-prefetch-order",
                ),
            ]
            await asyncio.gather(*tasks, return_exceptions=True)
        except Exception:
            logger.debug(
                "Call setup prefetch skipped (sync layer unavailable) sid=%s",
                session.call_sid[:6],
            )

    async def _run_prefetch(
        self,
        turn: TurnLatency,
        tool_calls: list[dict],
        session: SessionState,
        settings,
    ) -> None:
        t0 = time.monotonic()
        try:
            await run_tools_parallel(
                tool_calls,
                session,
                timeout_ms=settings.VOICE_TOOL_TIMEOUT_MS,
            )
        except Exception:
            logger.debug("Speculative prefetch failed — continuing without cache")
        finally:
            turn.prefetch_ms = (time.monotonic() - t0) * 1000


# ── Helper functions ───────────────────────────────────────────────────────────

def _apply_email_state(session: SessionState, intent_result: IntentResult) -> None:
    """
    Update session email state machine fields based on router intent.

    email_provided   → set pending_email (requires confirmation) or accumulate fragment
    email_correction → clear pending_email (caller rejected); update payment_flow_status
    email_confirmation → promote pending → confirmed; advance payment_flow_status

    Security: confirmed_email is only set here from pending. Never from raw
    entities without the confirmation step.
    """
    intent = intent_result.intent
    e = intent_result.entities

    if intent == "email_provided":
        raw_email = e.get("email", "")
        raw_text  = e.get("email_raw", "")

        if raw_email:
            try:
                from .email_capture import email_confidence
                confidence = email_confidence(raw_email, raw_text or raw_email)
            except Exception:
                confidence = "medium"
            session.pending_email = raw_email
            session.email_confidence = confidence
            # Clear any in-progress fragments — we have a complete email
            if hasattr(session, "pending_email_fragments"):
                session.pending_email_fragments = []
            # Advance payment flow state
            if not getattr(session, "confirmed_email", ""):
                session.payment_flow_status = "awaiting_email_confirmation"
            logger.debug(
                "email_provided: pending set conf=%s sid=%s",
                confidence, session.call_sid[:6],
            )
        elif raw_text:
            # No normalized email — try multi-turn fragment accumulation
            _accumulate_email_fragment(session, raw_text, intent_result)

    elif intent == "email_correction":
        if session.pending_email:
            rejected = session.pending_email
            session.pending_email = ""
            session.email_confidence = "low"
            session.email_rejected_count = getattr(session, "email_rejected_count", 0) + 1
            # Store rejected candidate so PaymentSafetyGuard can block reuse
            candidates: list = getattr(session, "rejected_email_candidates", None)
            if candidates is None:
                session.rejected_email_candidates = []
                candidates = session.rejected_email_candidates
            if rejected.lower().strip() not in [c.lower().strip() for c in candidates]:
                candidates.append(rejected)
        # Clear fragments on correction
        if hasattr(session, "pending_email_fragments"):
            session.pending_email_fragments = []
        # Revert payment flow state
        pfs = getattr(session, "payment_flow_status", "idle") or "idle"
        if pfs in ("awaiting_email_confirmation", "awaiting_send_confirmation"):
            session.payment_flow_status = "awaiting_email"
        logger.debug("email_correction: pending cleared sid=%s", session.call_sid[:6])

    elif intent == "email_confirmation":
        if session.pending_email:
            session.confirmed_email = session.pending_email
            session.pending_email = ""
            session.email_confidence = "high"
            # Advance payment flow state
            pfs = getattr(session, "payment_flow_status", "idle") or "idle"
            if pfs == "awaiting_email_confirmation":
                session.payment_flow_status = "awaiting_send_confirmation"
            logger.debug("email_confirmation: confirmed sid=%s", session.call_sid[:6])


def _accumulate_email_fragment(
    session: SessionState,
    raw_text: str,
    intent_result: IntentResult,
) -> None:
    """
    Accumulate a partial spoken email fragment for multi-turn assembly.

    Called from _apply_email_state when email_provided fires but the normalizer
    could not produce a complete email (e.g. "bashisultan766@gmail" without ".com").
    On the next turn if the caller says "dot com", fragments are assembled and
    set as pending_email awaiting confirmation.
    """
    from .email_capture import is_domain_suffix_only, assemble_email_from_fragments, email_confidence

    fragments: list = getattr(session, "pending_email_fragments", None)
    if fragments is None:
        session.pending_email_fragments = []
        fragments = session.pending_email_fragments

    current_turn = getattr(session, "turn_count", 0)
    last_turn    = getattr(session, "last_email_fragment_turn", -1)

    # Expire stale fragments after 4 turns
    if last_turn >= 0 and (current_turn - last_turn) > 4:
        fragments.clear()

    if is_domain_suffix_only(raw_text) and fragments:
        # This looks like a TLD completion ("dot com") — try to assemble
        candidate_fragments = fragments + [raw_text]
        assembled = assemble_email_from_fragments(candidate_fragments)
        if assembled:
            conf = email_confidence(assembled, " ".join(candidate_fragments))
            session.pending_email = assembled
            session.email_confidence = conf
            session.payment_flow_status = "awaiting_email_confirmation"
            fragments.clear()
            logger.debug(
                "email_fragment: assembled %d-part email conf=%s sid=%s",
                len(candidate_fragments), conf, session.call_sid[:6],
            )
    else:
        # Store this fragment for next-turn completion
        fragments.append(raw_text)
        session.last_email_fragment_turn = current_turn
        logger.debug(
            "email_fragment: stored fragment #%d sid=%s",
            len(fragments), session.call_sid[:6],
        )


async def _prefetch_customer(session: SessionState, cache) -> None:
    try:
        customer = await cache.get_by_phone(session.from_number)
        if customer and not session.caller_name:
            session.caller_name = customer.display_name
    except Exception:
        pass


async def _prefetch_recent_order(session: SessionState, cache) -> None:
    try:
        order = await cache.get_recent_by_phone(session.from_number)
        if order and not session.last_order_number:
            session.last_order_number = order.order_number
    except Exception:
        pass


def _build_router_context(
    intent_result: IntentResult,
    session: SessionState,
) -> Optional[str]:
    """
    Build compact, safe context block for the fallback run_agent_turn path.

    Never includes raw Shopify JSON, payment data, secrets, or unverified PII.
    """
    if intent_result.intent == "unknown":
        return None

    lines = ["[ROUTER CONTEXT — detected before LLM call, no live data]"]
    intent_human = intent_result.intent.replace("_", " ")
    conf_label = "high" if intent_result.confidence >= 0.85 else "medium"
    lines.append(f"Detected intent: {intent_human} (confidence: {conf_label})")

    e = intent_result.entities
    if e.get("isbn"):
        lines.append(f"Extracted ISBN: {e['isbn']}")
    if e.get("order_number"):
        lines.append(f"Extracted order number: {e['order_number']}")
    if e.get("product_phrase"):
        lines.append(f"Product search term: {e['product_phrase'][:60]}")
    if e.get("quantity"):
        lines.append(f"Quantity requested: {e['quantity']}")
    if e.get("email"):
        try:
            from ..caller.repository import mask_email
            lines.append(f"Caller email hint (not yet verified): {mask_email(e['email'])}")
        except Exception:
            pass
    if e.get("phone"):
        ph = str(e["phone"])
        tail = ph[-4:] if len(ph) >= 4 else "***"
        lines.append(f"Caller phone hint (not yet verified): ***{tail}")
    if session.prefetch_cache:
        n = len(session.prefetch_cache)
        lines.append(f"Pre-fetched: {n} tool result(s) ready in local cache")

    # Payment flow context — tells LLM what stage we're in
    pfs = getattr(session, "payment_flow_status", "idle") or "idle"
    if pfs != "idle":
        lines.append(f"Payment flow status: {pfs}")
    if getattr(session, "confirmed_email", ""):
        try:
            from ..caller.repository import mask_email
            lines.append(f"Confirmed email: {mask_email(session.confirmed_email)}")
        except Exception:
            lines.append("Confirmed email: [set]")
    elif getattr(session, "pending_email", ""):
        lines.append("Email status: pending confirmation (do NOT use for payment send)")

    return "\n".join(lines)


def _build_speculative_calls(
    intent_result: IntentResult,
    session: SessionState,
) -> list[dict]:
    """
    Build speculative tool calls for the fallback path only.

    The worker path does not use this — workers are selected by the
    orchestrator from the intent mapping, not from tool schemas.
    """
    calls = []
    e = intent_result.entities

    if intent_result.intent in (Intent.ISBN_SEARCH, Intent.PRODUCT_SEARCH, Intent.AUTHOR_SEARCH):
        query = e.get("isbn") or e.get("product_phrase", "")
        if query:
            calls.append({"name": "search_products", "args": {"query": query}})

    elif intent_result.intent == Intent.PRICE_QUESTION:
        query = e.get("product_phrase", "")
        if query:
            calls.append({"name": "search_products", "args": {"query": query}})

    elif intent_result.intent in (Intent.ORDER_LOOKUP, Intent.SHIPPING_QUESTION):
        order_number = e.get("order_number", "")
        email = e.get("email", "")
        if order_number:
            calls.append({"name": "lookup_order", "args": {
                "order_number": order_number,
                "customer_email": email,
            }})

    elif intent_result.intent == Intent.REFUND_STATUS:
        order_number = e.get("order_number", "")
        email = e.get("email", "")
        if order_number and email:
            calls.append({"name": "get_refund_status", "args": {
                "order_number": order_number,
                "customer_email": email,
            }})

    return calls


_engine: Optional[RealtimePipelineEngine] = None


def get_engine(settings=None) -> RealtimePipelineEngine:
    """Return the singleton engine instance."""
    global _engine
    if _engine is None:
        _engine = RealtimePipelineEngine(settings=settings)
    return _engine
