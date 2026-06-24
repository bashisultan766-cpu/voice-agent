"""Single Brain Orchestrator — final intent and answer authority (v4.16.0)."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Literal, TYPE_CHECKING

from openai import AsyncOpenAI

from .domain_boundary import classify_domain
from .prompt_loader import load_eric_system_prompt_text

if TYPE_CHECKING:
    from .memory_packet import MemoryPacket
    from .speculative_prefetch_manager import SpeculativePrefetchPacket

logger = logging.getLogger(__name__)

ResponseMode = Literal[
    "direct_answer",
    "domain_answer",
    "needs_tools",
    "clarify",
    "out_of_domain_redirect",
    "safe_refusal",
    "hold",
]
DomainStatus = Literal["in_domain", "domain_adjacent", "out_of_domain"]

_GREETING_PAT = re.compile(
    r"^\s*(?:hello|hi|hey)(?:\s+there)?(?:\s*,?\s*(?:how are you|how are ya|how'?s it going))?"
    r"(?:\s*,?\s*(?:brother|buddy|friend|man|sir|ma'?am))?\s*[.!?]?\s*$",
    re.I,
)
_HELLO_ONLY_PAT = re.compile(r"^\s*hello\s*[.!?]?\s*$", re.I)
_HOW_ARE_YOU_PAT = re.compile(r"\bhow are you\b", re.I)
_PRESENCE_PAT = re.compile(r"\b(?:are you there|hello\?|you still there)\b", re.I)
_HEAR_ME_PAT = re.compile(r"\bcan you hear me\b", re.I)
_IDENTITY_CONFIRM_PAT = re.compile(
    r"\b(?:your name is eric|name is eric)\b.*\b(?:yes or no|right\??|correct\??)\b",
    re.I,
)
_IDENTITY_PAT = re.compile(
    r"\b(?:what(?:'s| is) your name|who are you|tell me your name)\b",
    re.I,
)
_META_COMPLAINT_PAT = re.compile(
    r"\b(?:not using llm|why are you not|you are not working|this is not working)\b",
    re.I,
)
_THANKS_PAT = re.compile(r"\b(?:thanks|thank you|okay|ok)\b", re.I)
_PAYMENT_LINK_PAT = re.compile(r"\b(?:send payment link|payment link|pay now)\b", re.I)
_VAGUE_NEWSPAPER_PAT = re.compile(
    r"\b(?:can you give me(?:\s+(?:the|a))?\s*newspaper|give me(?:\s+(?:the|a))?\s*newspaper|"
    r"i need(?:\s+a)?\s*newspaper|looking for(?:\s+a)?\s*newspaper)\b",
    re.I,
)
_VAGUE_MAGAZINE_PAT = re.compile(
    r"\b(?:can you give me(?:\s+(?:the|a))?\s*magazine|give me(?:\s+(?:the|a))?\s*magazine)\b",
    re.I,
)
_ISBN_PAT = re.compile(r"\b(\d{10,13}|\d{1,5}[- ]\d{1,7}[- ]\d{1,7}[- ][\dxX])\b")

_ANSWER_GREETING = "I'm doing well, thank you. How can I help you today?"
_ANSWER_HELLO = "Yes, I'm here. How can I help?"
_ANSWER_IDENTITY_CONFIRM = "Yes, my name is Eric. I'm with SureShot Books."
_ANSWER_IDENTITY = "My name is Eric. I'm with SureShot Books."
_ANSWER_META = "I'm here and ready to help. What would you like to do next?"
_ANSWER_PRESENCE = "Yes, I'm here. How can I help you today?"
_ANSWER_HEAR = "Yes, I can hear you. How can I help?"
_ANSWER_VAGUE_NEWSPAPER = "Sure. Which newspaper are you looking for?"
_ANSWER_VAGUE_MAGAZINE = "Sure. Which magazine are you looking for?"


@dataclass
class ToolPlan:
    categories: list[str] = field(default_factory=list)
    intent: str = ""
    entities: dict = field(default_factory=dict)
    search_query: str = ""
    mutating: bool = False
    approved_by_brain: bool = True


@dataclass
class BrainDecision:
    response_mode: ResponseMode
    intent: str
    confidence: float
    answer: str | None
    accepted_prefetch_ids: list[str] = field(default_factory=list)
    tool_plan: ToolPlan | None = None
    required_entities: dict = field(default_factory=dict)
    missing_entities: list[str] = field(default_factory=list)
    domain_status: DomainStatus = "in_domain"
    safety_flags: list[str] = field(default_factory=list)
    reasoning_summary: str = ""


@dataclass
class BrainOrchestratorInput:
    call_sid: str
    user_text: str
    prompt_pack: str = ""
    memory_packet: "MemoryPacket | None" = None
    commerce_session_summary: str = ""
    cart_summary: str = ""
    speculative_prefetch_packet: "SpeculativePrefetchPacket | None" = None
    last_assistant_question: str = ""
    active_expected_next: str = ""


class BrainOrchestrator:
    """Only component allowed to decide final intent and approve tool execution."""

    def __init__(self, settings=None) -> None:
        if settings is None:
            from ..config import get_settings
            settings = get_settings()
        self._settings = settings

    async def decide(self, inp: BrainOrchestratorInput) -> BrainDecision:
        t0 = time.monotonic()
        sid = (inp.call_sid or "")[:6]
        text = re.sub(r"\s+", " ", (inp.user_text or "").strip())
        logger.info("brain_decision_started sid=%s text=%s", sid, text[:40])

        fast = self._deterministic_fast_path(text, inp)
        if fast is not None:
            ms = (time.monotonic() - t0) * 1000
            logger.info(
                "brain_decision_complete sid=%s mode=%s intent=%s ms=%.0f source=fast_path",
                sid, fast.response_mode, fast.intent, ms,
            )
            return fast

        domain = classify_domain(text)
        if domain.status == "out_of_domain" and domain.redirect_answer:
            ms = (time.monotonic() - t0) * 1000
            logger.info("brain_decision_complete sid=%s mode=out_of_domain_redirect ms=%.0f", sid, ms)
            return BrainDecision(
                response_mode="out_of_domain_redirect",
                intent="off_domain_redirect",
                confidence=0.95,
                answer=domain.redirect_answer,
                domain_status="out_of_domain",
                reasoning_summary="out_of_domain_redirect",
            )

        if domain.catalog_search:
            plan = self._catalog_tool_plan(text, domain)
            ms = (time.monotonic() - t0) * 1000
            logger.info("brain_decision_complete sid=%s mode=needs_tools intent=%s ms=%.0f", sid, plan.intent, ms)
            return BrainDecision(
                response_mode="needs_tools",
                intent=plan.intent,
                confidence=0.9,
                answer=None,
                tool_plan=plan,
                domain_status=domain.status,
                reasoning_summary="catalog_search_from_domain",
            )

        if _PAYMENT_LINK_PAT.search(text):
            return self._payment_decision(inp)

        isbn_match = _ISBN_PAT.search(text)
        if isbn_match:
            plan = ToolPlan(
                categories=["isbn_lookup", "catalog_search"],
                intent="isbn_lookup",
                entities={"isbn": re.sub(r"[^\dXx]", "", isbn_match.group(1))},
                search_query=text,
            )
            return BrainDecision(
                response_mode="needs_tools",
                intent="isbn_lookup",
                confidence=0.95,
                answer=None,
                tool_plan=plan,
                reasoning_summary="isbn_detected",
            )

        llm_decision = await self._llm_decide(inp, domain)
        ms = (time.monotonic() - t0) * 1000
        logger.info(
            "brain_decision_complete sid=%s mode=%s intent=%s ms=%.0f source=llm",
            sid, llm_decision.response_mode, llm_decision.intent, ms,
        )
        return llm_decision

    def _deterministic_fast_path(
        self, text: str, inp: BrainOrchestratorInput,
    ) -> BrainDecision | None:
        if not getattr(self._settings, "VOICE_BRAIN_DETERMINISTIC_GREETING_FASTPATH", True):
            return None

        if _HELLO_ONLY_PAT.match(text) or _PRESENCE_PAT.search(text):
            return BrainDecision(
                response_mode="direct_answer",
                intent="presence_check",
                confidence=0.99,
                answer=_ANSWER_HELLO,
                reasoning_summary="greeting_presence_fast_path",
            )
        if _GREETING_PAT.match(text) or _HOW_ARE_YOU_PAT.search(text):
            return BrainDecision(
                response_mode="direct_answer",
                intent="small_talk",
                confidence=0.99,
                answer=_ANSWER_GREETING,
                reasoning_summary="greeting_fast_path",
            )
        if _HEAR_ME_PAT.search(text):
            return BrainDecision(
                response_mode="direct_answer",
                intent="presence_check",
                confidence=0.99,
                answer=_ANSWER_HEAR,
                reasoning_summary="hear_me_fast_path",
            )
        if _IDENTITY_CONFIRM_PAT.search(text):
            return BrainDecision(
                response_mode="direct_answer",
                intent="identity_confirmation",
                confidence=0.99,
                answer=_ANSWER_IDENTITY_CONFIRM,
                reasoning_summary="identity_confirm_fast_path",
            )
        if _IDENTITY_PAT.search(text):
            return BrainDecision(
                response_mode="direct_answer",
                intent="identity",
                confidence=0.99,
                answer=_ANSWER_IDENTITY,
                reasoning_summary="identity_fast_path",
            )
        if _META_COMPLAINT_PAT.search(text):
            return BrainDecision(
                response_mode="direct_answer",
                intent="meta_complaint",
                confidence=0.95,
                answer=_ANSWER_META,
                reasoning_summary="meta_complaint_fast_path",
            )
        if _THANKS_PAT.fullmatch(text) and len(text.split()) <= 3:
            return BrainDecision(
                response_mode="direct_answer",
                intent="acknowledgment",
                confidence=0.9,
                answer="You're welcome. How can I help you next?",
                reasoning_summary="thanks_fast_path",
            )
        if _VAGUE_NEWSPAPER_PAT.search(text) and not re.search(
            r"\b(usa today|wall street|new york times|times)\b", text, re.I,
        ):
            return BrainDecision(
                response_mode="clarify",
                intent="newspaper_request",
                confidence=0.95,
                answer=_ANSWER_VAGUE_NEWSPAPER,
                reasoning_summary="vague_newspaper_fast_path",
            )
        if _VAGUE_MAGAZINE_PAT.search(text):
            return BrainDecision(
                response_mode="clarify",
                intent="magazine_request",
                confidence=0.95,
                answer=_ANSWER_VAGUE_MAGAZINE,
                reasoning_summary="vague_magazine_fast_path",
            )
        return None

    def _catalog_tool_plan(self, text: str, domain) -> ToolPlan:
        lowered = text.lower()
        categories = ["catalog_search"]
        intent = "catalog_product_search"
        entities: dict = {"search_query": text}
        if "newspaper" in lowered or "usa today" in lowered:
            intent = "newspaper_search"
            entities["product_kind"] = "newspaper"
        elif "magazine" in lowered or "people magazine" in lowered:
            intent = "magazine_search"
            entities["product_kind"] = "magazine"
        elif "subscription" in lowered or re.search(r"\b\d+\s*months?\b", lowered):
            intent = "subscription_search"
            entities["product_kind"] = "subscription"
        return ToolPlan(categories=categories, intent=intent, entities=entities, search_query=text)

    def _payment_decision(self, inp: BrainOrchestratorInput) -> BrainDecision:
        cart = (inp.cart_summary or "").strip()
        has_cart = bool(cart) and "0 confirmed" not in cart.lower()
        if not has_cart:
            return BrainDecision(
                response_mode="clarify",
                intent="payment_clarify",
                confidence=0.9,
                answer="I can help with that. What item would you like to order first?",
                missing_entities=["cart_item"],
                reasoning_summary="payment_no_cart",
            )
        summary = (inp.commerce_session_summary or "").lower()
        if "email" not in summary or "confirmed" not in summary:
            return BrainDecision(
                response_mode="clarify",
                intent="payment_clarify",
                confidence=0.9,
                answer="What email address should I send the payment link to?",
                missing_entities=["email"],
                reasoning_summary="payment_no_email",
            )
        return BrainDecision(
            response_mode="needs_tools",
            intent="payment",
            confidence=0.9,
            answer=None,
            tool_plan=ToolPlan(
                categories=["payment_flow"],
                intent="payment",
                mutating=True,
            ),
            reasoning_summary="payment_approved",
        )

    async def _llm_decide(self, inp: BrainOrchestratorInput, domain) -> BrainDecision:
        timeout_ms = getattr(self._settings, "VOICE_BRAIN_TIMEOUT_MS", 2500)
        model = getattr(self._settings, "VOICE_BRAIN_MODEL", "gpt-4o-mini")
        prompt = inp.prompt_pack or load_eric_system_prompt_text()
        prefetch_summary = ""
        if inp.speculative_prefetch_packet and inp.speculative_prefetch_packet.results:
            lines = []
            for r in inp.speculative_prefetch_packet.results[:8]:
                lines.append(f"- {r.scout_name}/{r.kind} conf={r.confidence:.2f}")
            prefetch_summary = "\n".join(lines)

        user_block = (
            f"User: {inp.user_text}\n"
            f"Cart: {inp.cart_summary or 'empty'}\n"
            f"Expected next: {inp.active_expected_next or 'none'}\n"
            f"Prefetch scouts:\n{prefetch_summary or 'none yet'}\n"
            f"Domain hint: {domain.status}\n"
            "Return JSON: response_mode, intent, confidence, answer, tool_categories, "
            "search_query, reasoning_summary (internal only)."
        )
        try:
            client = AsyncOpenAI(api_key=self._settings.OPENAI_API_KEY)
            resp = await asyncio.wait_for(
                client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": prompt},
                        {"role": "user", "content": user_block},
                    ],
                    response_format={"type": "json_object"},
                    temperature=0.2,
                    max_tokens=400,
                ),
                timeout=timeout_ms / 1000,
            )
            raw = json.loads(resp.choices[0].message.content or "{}")
        except Exception as exc:
            logger.warning("brain_llm_timeout sid=%s err=%s", inp.call_sid[:6], str(exc)[:40])
            return BrainDecision(
                response_mode="clarify",
                intent="unknown",
                confidence=0.5,
                answer="How can I help you with SureShot Books today?",
                reasoning_summary="brain_timeout_fallback",
            )

        mode = str(raw.get("response_mode", "direct_answer"))
        if mode not in (
            "direct_answer", "domain_answer", "needs_tools", "clarify",
            "out_of_domain_redirect", "safe_refusal", "hold",
        ):
            mode = "clarify"
        intent = str(raw.get("intent", "unknown"))
        answer = raw.get("answer") or raw.get("direct_answer")
        tool_plan = None
        categories = list(raw.get("tool_categories") or [])
        if mode == "needs_tools" and categories:
            tool_plan = ToolPlan(
                categories=categories,
                intent=intent,
                entities=dict(raw.get("tool_entities") or {}),
                search_query=str(raw.get("search_query") or inp.user_text),
                mutating=any(c in ("payment_flow", "cart_mutation", "email_capture") for c in categories),
            )
        return BrainDecision(
            response_mode=mode,  # type: ignore[arg-type]
            intent=intent,
            confidence=float(raw.get("confidence", 0.8)),
            answer=answer,
            tool_plan=tool_plan,
            domain_status=domain.status,
            safety_flags=list(raw.get("safety_flags") or []),
            reasoning_summary=str(raw.get("reasoning_summary", "llm_decision"))[:200],
        )


def brain_decision_to_legacy_dict(decision: BrainDecision) -> dict:
    """Convert BrainDecision to legacy main_llm decision dict for worker compatibility."""
    tool_categories = list(decision.tool_plan.categories) if decision.tool_plan else []
    return {
        "response_mode": decision.response_mode,
        "intent": decision.intent,
        "confidence": decision.confidence,
        "direct_answer": decision.answer or "",
        "tool_categories": tool_categories,
        "tool_reason": decision.reasoning_summary,
        "one_question_to_ask": "",
        "domain_boundary": decision.domain_status,
        "safety_flags": list(decision.safety_flags),
        "memory_instruction": "",
        "expected_next": "",
        "search_query": (decision.tool_plan.search_query if decision.tool_plan else ""),
        "tool_entities": dict(decision.tool_plan.entities) if decision.tool_plan else {},
        "brain_approved": True,
    }
