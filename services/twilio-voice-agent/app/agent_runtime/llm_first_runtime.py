"""
LLM-first voice runtime (v4.17) — single, clean caller-facing brain.

Design goals (ElevenLabs-style agent):
  * The LLM is the main brain. Every caller utterance goes through the LLM
    unless it is an ultra-fast deterministic event (welcome / interrupt / DTMF /
    no-speech) or a trivially deterministic conversational confirmation.
  * The LLM always receives a complete context packet:
      - system prompt pack (Eric identity + policy)
      - last 50 conversation turns
      - extracted durable memory facts
      - caller profile summary (friendly recognition only)
      - current cart / session state
      - available Shopify tools
      - safe business policy
  * Business FACTS (price, stock, orders, refunds, tracking, facility approval,
    payment links) come from tools — never from guessing.
  * No secrets, raw tool JSON, or raw prompts are ever logged.

This module owns context assembly + conversational fast-paths and delegates
tool execution + final answer to the existing EricAgentRuntime so there is one
authoritative tool/worker layer.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional, TYPE_CHECKING

from . import openai_health
from . import pending_action as pa
from .business_intent_resolver import resolve_business_intent
from .caller_identity import build_greeting, get_caller_info, apply_to_session
from .call_memory_manager import CallMemoryManager
from .memory_packet import build_memory_packet
from .prompt_loader import load_eric_system_prompt_text

if TYPE_CHECKING:
    from ..state.models import SafeCallerContext, SessionState

logger = logging.getLogger(__name__)


# Canonical caller-facing tool surface (names match tools/registry.py).
AVAILABLE_TOOLS: tuple[dict[str, str], ...] = (
    {"name": "GetCallerInfo", "desc": "Recognise a returning caller by phone (friendly only)."},
    {"name": "SaveCallerName", "desc": "Save the caller's name for this call."},
    {"name": "SearchCustomerByPhone", "desc": "Find a Shopify customer by phone number."},
    {"name": "SearchOrdersByPhone", "desc": "Find recent Shopify orders by phone."},
    {"name": "GetOrder", "desc": "Look up an order by number + email/phone."},
    {"name": "SureShotCatalogSearch", "desc": "Search the book catalog."},
    {"name": "SearchBookByISBN", "desc": "Find a book by a validated ISBN."},
    {"name": "SearchBookByTitle", "desc": "Find a book by title."},
    {"name": "CalculatePricing", "desc": "Compute price + shipping for items."},
    {"name": "SendPaymentLink", "desc": "Create and email a payment link (after confirmation)."},
    {"name": "SendFacilityPaymentLink", "desc": "Payment link for a facility/inmate order."},
    {"name": "CheckFacilityApproval", "desc": "Check if a facility is approved."},
    {"name": "CheckOrderFacilityRestrictions", "desc": "Check facility restrictions for an order."},
    {"name": "EscalateToCustomerService", "desc": "Hand off to a human."},
)

# Short, safe business policy injected alongside the prompt pack. No secrets.
SAFE_BUSINESS_POLICY = (
    "Use tools for business facts (availability, price, stock, orders, refunds, "
    "tracking, facility approval, payment links, cancellations). Never guess "
    "these. Phone recognition is friendly only, never identity verification. "
    "Never reveal private details from caller ID alone. Never say 'Processing "
    "Fee'. Ask one question at a time. Keep replies brief and natural."
)


@dataclass
class LLMTurnContext:
    """Everything the LLM brain receives for one caller turn."""

    system_prompt: str
    prompt_pack_hash: str
    prompt_pack_chars: int
    recent_turns: list[tuple[str, str]] = field(default_factory=list)
    memory_facts: list[str] = field(default_factory=list)
    caller_profile: dict[str, Any] = field(default_factory=dict)
    cart_state: dict[str, Any] = field(default_factory=dict)
    session_state: dict[str, Any] = field(default_factory=dict)
    tools: list[dict[str, str]] = field(default_factory=list)
    policy: str = ""
    caller_text: str = ""

    def has_prompt(self) -> bool:
        return bool(self.system_prompt.strip())

    def has_tools(self) -> bool:
        return bool(self.tools)


@dataclass
class LLMDecision:
    """A deterministic conversational decision (no LLM call needed)."""

    response_mode: str          # direct_answer | needs_tools
    intent: str
    answer: str = ""
    tool_categories: list[str] = field(default_factory=list)
    source: str = ""
    expected_next: str = ""


def _safe_caller_profile(session: "SessionState") -> dict[str, Any]:
    from ..caller.repository import mask_email

    return {
        "is_returning_caller": bool(getattr(session, "is_returning_caller", False)),
        "caller_name": getattr(session, "caller_name", "") or "",
        "preferred_email_masked": (
            mask_email(session.caller_email) if getattr(session, "caller_email", "") else ""
        ),
        "last_order_number": getattr(session, "last_order_number", "") or "",
        # Verification reflects THIS call only — phone match never sets these.
        "verified_email": bool(getattr(session, "verified_email", False)),
        "verified_phone": bool(getattr(session, "verified_phone", False)),
    }


def _cart_state(session: "SessionState") -> dict[str, Any]:
    try:
        from ..cart.session import get_ledger

        ledger = get_ledger(session)
        return {"confirmed_count": ledger.confirmed_count()}
    except Exception:  # noqa: BLE001
        return {"confirmed_count": 0}


def _session_state(session: "SessionState") -> dict[str, Any]:
    return {
        "payment_flow_status": getattr(session, "payment_flow_status", "idle") or "idle",
        "email_state": (
            "confirmed" if getattr(session, "confirmed_email", "")
            else ("pending" if getattr(session, "pending_email", "") else "none")
        ),
        "has_pending_action": pa.get_pending_action(session) is not None,
    }


class LLMFirstRuntime:
    """Single LLM-first runtime. Assembles context, routes, delegates tools."""

    def __init__(self, settings=None):
        from ..config import get_settings

        self._settings = settings or get_settings()

    # ── Context assembly ──────────────────────────────────────────────────
    def available_tools(self) -> list[dict[str, str]]:
        return [dict(t) for t in AVAILABLE_TOOLS]

    def build_llm_context(
        self, session: "SessionState", caller_text: str
    ) -> LLMTurnContext:
        """Assemble the full LLM input packet for one turn (no LLM call)."""
        from .prompt_pack_loader import load_prompt_pack

        system_prompt = load_eric_system_prompt_text()
        pack_hash, pack_chars = "", len(system_prompt)
        try:
            snap = load_prompt_pack()
            pack_hash, pack_chars = snap.prompt_hash, snap.prompt_chars
        except Exception:  # noqa: BLE001 — fall back to single-file prompt
            pass

        packet = build_memory_packet(session)
        max_turns = getattr(self._settings, "VOICE_MEMORY_TURNS", 50)

        ctx = LLMTurnContext(
            system_prompt=system_prompt,
            prompt_pack_hash=pack_hash,
            prompt_pack_chars=pack_chars,
            recent_turns=list(packet.recent_turns[-max_turns:]),
            memory_facts=list(packet.facts),
            caller_profile=_safe_caller_profile(session),
            cart_state=_cart_state(session),
            session_state=_session_state(session),
            tools=self.available_tools(),
            policy=SAFE_BUSINESS_POLICY,
            caller_text=caller_text,
        )
        logger.info(
            "llm_first_context_built sid=%s prompt_pack_hash=%s chars=%d turns=%d "
            "facts=%d tools=%d returning=%s",
            session.call_sid[:6],
            pack_hash or "single_file",
            pack_chars,
            len(ctx.recent_turns),
            len(ctx.memory_facts),
            len(ctx.tools),
            ctx.caller_profile["is_returning_caller"],
        )
        return ctx

    # ── Deterministic conversational fast paths (no LLM cost) ─────────────
    def decide_conversational(
        self, session: "SessionState", caller_text: str
    ) -> Optional[LLMDecision]:
        """
        Resolve trivially-deterministic conversational turns without the LLM:
          * a bare "yes"/"no" that confirms/declines a pending action
          * "Can I give you the ISBN?" style offers (accept conversationally)

        Returns None to defer to the LLM for everything else.
        """
        text = (caller_text or "").strip()
        if not text:
            return None

        # 1) Pending-action confirmation: "yes" executes the offered action.
        confirmed = pa.consume_if_affirmative(session, text)
        if confirmed is not None:
            logger.info(
                "llm_first_pending_action_used sid=%s action=%s",
                session.call_sid[:6], confirmed.action,
            )
            return LLMDecision(
                response_mode="needs_tools",
                intent=confirmed.action,
                tool_categories=confirmed.payload.get("tool_categories", []),
                source="pending_action",
            )

        # 2) Business-intent conversational accepts (e.g. ISBN offer).
        biz = resolve_business_intent(text)
        if biz.matched and biz.response_mode == "direct_answer" and biz.intent != "unknown":
            # Treat ISBN/title collection offers as a natural "yes, go ahead".
            return LLMDecision(
                response_mode="direct_answer",
                intent=biz.intent,
                answer=biz.direct_answer or "",
                source="business_intent",
                expected_next=getattr(biz, "expected_next", "") or "",
            )
        return None

    # ── Caller identity at call start ─────────────────────────────────────
    async def resolve_identity(
        self, session: "SessionState", *, allow_live: bool = True
    ) -> dict[str, Any]:
        info = await get_caller_info(getattr(session, "from_number", ""), allow_live=allow_live)
        apply_to_session(session, info)
        return info

    def greeting_for(self, info: dict[str, Any], *, late: bool = False) -> str:
        return build_greeting(info, late=late)

    # ── Turn handling ─────────────────────────────────────────────────────
    async def handle_turn(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable[[dict], Awaitable[None]],
        caller_context: Optional["SafeCallerContext"] = None,
        turn=None,
    ):
        """
        Handle one caller turn.

        Assembles the LLM context, tries deterministic conversational handling,
        otherwise delegates to EricAgentRuntime's LLM brain + tool layer. Always
        records durable memory facts after the turn.
        """
        sid = session.call_sid[:6]
        openai_health.log_call_health(session.call_sid, self._settings)

        ctx = self.build_llm_context(session, caller_text)
        if not ctx.has_prompt():
            logger.error("llm_first_no_prompt sid=%s — prompt pack failed to load", sid)

        decision = self.decide_conversational(session, caller_text)
        if decision is not None and decision.response_mode == "direct_answer" and decision.answer:
            from ..safety.response_sanitizer import (
                log_assistant_response,
                sanitize_customer_response,
            )

            answer = sanitize_customer_response(
                decision.answer, intent=decision.intent, call_sid=session.call_sid
            ).text
            await _await_send(send, {"type": "text", "token": answer, "last": True})
            log_assistant_response(answer, call_sid=session.call_sid, intent=decision.intent)
            CallMemoryManager.update_after_turn(
                session, caller_text, answer, intent=decision.intent
            )
            logger.info("llm_first_direct sid=%s intent=%s", sid, decision.intent)
            return _result(answer, decision.intent)

        # Delegate LLM brain + tool execution to the authoritative runtime's
        # internal handlers (bypass the mode dispatcher to avoid recursion).
        from .runtime import get_eric_runtime

        runtime = get_eric_runtime()
        use_brain = bool(getattr(self._settings, "VOICE_BRAIN_ORCHESTRATOR_ENABLED", False))
        if use_brain:
            result = await runtime._handle_brain_orchestrator_turn(
                session, caller_text, send, caller_context, turn,
            )
        else:
            result = await runtime._handle_main_llm_agent_turn(
                session, caller_text, send, caller_context, turn,
            )
        # Memory facts are also recorded inside the delegate, but ensure the
        # durable extractor ran on this utterance.
        try:
            from ..conversation.call_memory import extract_durable_facts

            extract_durable_facts(session, caller_text)
        except Exception:  # noqa: BLE001
            pass
        return result


async def _await_send(send: Callable, msg: dict) -> None:
    import asyncio

    out = send(msg)
    if asyncio.iscoroutine(out):
        await out


def _result(answer: str, intent: str):
    """Build a RuntimeTurnResult for the WebSocket layer."""
    from .types import RuntimeTurnResult

    return RuntimeTurnResult(response_text=answer, source="llm_first_direct")


_runtime: Optional[LLMFirstRuntime] = None


def get_llm_first_runtime(settings=None) -> LLMFirstRuntime:
    global _runtime
    if _runtime is None:
        _runtime = LLMFirstRuntime(settings=settings)
    return _runtime


def is_llm_first_mode(settings=None) -> bool:
    from ..config import get_settings

    s = settings or get_settings()
    return getattr(s, "VOICE_AGENT_RUNTIME_MODE", "") == "llm_first"
