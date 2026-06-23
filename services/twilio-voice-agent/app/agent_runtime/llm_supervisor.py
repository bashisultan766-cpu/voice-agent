"""
LLM Supervisor — primary semantic decision-maker (v4.11).

Runs after TurnAssembler with full Eric policy. No OpenAI tools=.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import TYPE_CHECKING, Any, Optional

from openai import AsyncOpenAI

from .call_memory_manager import is_repeat_or_clarification_request
from .eric_master_policy import build_eric_brain_system_prompt
from .knowledge_base import retrieve_knowledge_snippets
from .memory_packet import MemoryPacket
from .types import SupervisorDecision, StatePacket, WorkerRequest

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

from ..catalog.query_specificity import (
    has_explicit_book_search_context,
    is_general_how_to_query,
    is_off_domain_non_book_query,
    should_block_router_product_search,
)

_HOW_ARE_YOU = re.compile(
    r"\b(how are you|how.?s it going|how you doing|how do you do)\b", re.I,
)
_NAME_Q = re.compile(
    r"\b(what(?:'s| is) your name|who are you|your name please)\b", re.I,
)
_JOB_Q = re.compile(
    r"\b(what(?:'s| is) your job|what do you do|what can you do)\b", re.I,
)
_COMPANY_Q = re.compile(
    r"\b(what company|who do you work for|sureshot|what store)\b", re.I,
)
_OUT_OF_DOMAIN = re.compile(
    r"\b("
    r"who is (?:donald )?trump|where is (?:donald )?trump|"
    r"who won (?:the )?game|sports news|what(?:'s| is) the weather|"
    r"who is the president|tell me (?:about )?(?:politics|sports)"
    r")\b",
    re.I,
)
_TOPIC_BOOK = re.compile(
    r"\b("
    r"(?:do you have|got any|looking for|search for|find) (?:books? about|books on)|"
    r"books about .+|books on .+|football books|sports books"
    r")\b",
    re.I,
)
_GENERIC_BOOK = re.compile(
    r"\b(i need (?:a )?books?|i want (?:a )?books?|do you sell books?)\b", re.I,
)
_ORDER_Q = re.compile(
    r"\b(order|tracking|where is my order|where is (?:the )?order|check my order)\b", re.I,
)
_SHIPPING_Q = re.compile(r"\b(shipping|subtotal|delivery)\b", re.I)
_REFUND_Q = re.compile(r"\b(refund|money back|charge back)\b", re.I)
_FACILITY_Q = re.compile(r"\b(facility|approved|inmate|prison|jail)\b", re.I)
_WAIT_PHRASE = re.compile(
    r"\b(wait|hold on|one second|one moment|let me repeat|i repeat)\b", re.I,
)
_RED_RIVER = re.compile(r"red\s+river\s+vengeance", re.I)


def _parse_supervisor_json(raw: dict) -> SupervisorDecision:
    intent = str(raw.get("user_intent", "unknown")).strip()
    mood = str(raw.get("customer_mood", "normal")).strip()
    boundary = str(raw.get("domain_boundary", "inside_sureshot")).strip()

    workers_raw = raw.get("worker_requests") or []
    workers: list[WorkerRequest] = []
    if isinstance(workers_raw, list):
        for item in workers_raw[:8]:
            if isinstance(item, dict):
                workers.append(WorkerRequest(
                    worker=str(item.get("worker", "none")),
                    reason=str(item.get("reason", ""))[:100],
                    can_run_parallel=bool(item.get("can_run_parallel", True)),
                ))

    conf = raw.get("confidence", 0.0)
    try:
        conf = float(conf)
    except (TypeError, ValueError):
        conf = 0.0

    facts = raw.get("facts_needed") or []
    if not isinstance(facts, list):
        facts = []

    must_not = raw.get("must_not_say") or ["Processing Fee"]
    if not isinstance(must_not, list):
        must_not = ["Processing Fee"]

    mem = raw.get("memory_updates") or []
    if not isinstance(mem, list):
        mem = []

    return SupervisorDecision(
        user_intent=intent,
        confidence=max(0.0, min(1.0, conf)),
        customer_mood=mood if mood in ("normal", "confused", "frustrated", "angry") else "normal",
        domain_boundary=boundary,
        worker_requests=workers,
        facts_needed=[str(f) for f in facts[:8]],
        should_answer_now=bool(raw.get("should_answer_now", True)),
        should_wait_for_more_speech=bool(raw.get("should_wait_for_more_speech", False)),
        response_strategy=str(raw.get("response_strategy", "direct")),
        one_question_to_ask=str(raw.get("one_question_to_ask", ""))[:200],
        must_not_say=[str(x) for x in must_not[:10]],
        memory_updates=[str(x) for x in mem[:8]],
        response_draft=str(raw.get("response_draft", ""))[:300],
        source="llm",
    )


def _override_router_hint(
    caller_text: str,
    router_intent: str,
    router_entities: dict,
) -> Optional[SupervisorDecision]:
    """
    Override router_hint when it would trigger a bad product search.

    Router hint is advisory only — supervisor must not trust misheard titles.
    """
    t = (caller_text or "").strip()
    if not t or not router_intent or router_intent == "unknown":
        return None

    search_intents = {"book_title_search", "product_search", "explicit_title_search", "author_search"}
    if router_intent not in search_intents:
        return None

    if should_block_router_product_search(t, router_intent):
        if has_explicit_book_search_context(t) and _TOPIC_BOOK.search(t):
            phrase = router_entities.get("product_phrase", t)
            return SupervisorDecision(
                user_intent="book_topic_allowed",
                confidence=0.90,
                domain_boundary="book_topic_allowed",
                worker_requests=[WorkerRequest(
                    worker="catalog_search",
                    reason="subject book search",
                    can_run_parallel=True,
                )],
                entities={"product_phrase": phrase[:80]},
                response_strategy="domain_redirect",
                source="router_override",
            )
        return SupervisorDecision(
            user_intent="out_of_domain",
            confidence=0.91,
            domain_boundary="outside_domain_redirect",
            response_strategy="domain_redirect",
            source="router_override",
        )

    if is_general_how_to_query(t) and not has_explicit_book_search_context(t):
        return SupervisorDecision(
            user_intent="out_of_domain",
            confidence=0.92,
            domain_boundary="outside_domain_redirect",
            response_strategy="domain_redirect",
            source="router_override",
        )

    return None


def _fast_path(
    caller_text: str,
    router_intent: str,
    router_entities: dict,
    session: "SessionState",
) -> Optional[SupervisorDecision]:
    t = (caller_text or "").strip()
    if not t:
        return None

    if _WAIT_PHRASE.search(t):
        return SupervisorDecision(
            user_intent="unknown",
            confidence=0.95,
            should_answer_now=False,
            should_wait_for_more_speech=True,
            response_strategy="direct",
            source="fast_path",
        )

    if _RED_RIVER.search(t):
        return SupervisorDecision(
            user_intent="book_search",
            confidence=0.98,
            should_answer_now=True,
            response_strategy="direct",
            source="fast_path",
        )

    if is_repeat_or_clarification_request(t):
        return SupervisorDecision(
            user_intent="repeat_clarification",
            confidence=0.94,
            response_strategy="repair",
            source="fast_path",
        )

    if _NAME_Q.search(t):
        return SupervisorDecision(
            user_intent="identity",
            confidence=0.96,
            response_strategy="direct",
            source="fast_path",
        )

    if is_general_how_to_query(t) and not has_explicit_book_search_context(t):
        return SupervisorDecision(
            user_intent="out_of_domain",
            confidence=0.93,
            domain_boundary="outside_domain_redirect",
            response_strategy="domain_redirect",
            source="fast_path",
        )

    if is_off_domain_non_book_query(t) and not _TOPIC_BOOK.search(t):
        return SupervisorDecision(
            user_intent="out_of_domain",
            confidence=0.92,
            domain_boundary="outside_domain_redirect",
            response_strategy="domain_redirect",
            source="fast_path",
        )

    if _HOW_ARE_YOU.search(t):
        return SupervisorDecision(
            user_intent="small_talk",
            confidence=0.95,
            response_strategy="direct",
            source="fast_path",
        )

    if _JOB_Q.search(t) and not _NAME_Q.search(t):
        return SupervisorDecision(
            user_intent="company_question",
            confidence=0.95,
            worker_requests=[],
            response_strategy="direct",
            source="fast_path",
        )

    if _COMPANY_Q.search(t) and not _NAME_Q.search(t):
        return SupervisorDecision(
            user_intent="company_question",
            confidence=0.94,
            response_strategy="direct",
            source="fast_path",
        )

    if _TOPIC_BOOK.search(t):
        phrase = router_entities.get("product_phrase", t)
        return SupervisorDecision(
            user_intent="book_topic_allowed",
            confidence=0.91,
            domain_boundary="book_topic_allowed",
            worker_requests=[WorkerRequest(
                worker="catalog_search",
                reason="subject book search",
                can_run_parallel=True,
            )],
            entities={"product_phrase": phrase[:80]},
            response_strategy="direct",
            source="fast_path",
        )

    if _OUT_OF_DOMAIN.search(t) and not _TOPIC_BOOK.search(t):
        return SupervisorDecision(
            user_intent="out_of_domain",
            confidence=0.92,
            domain_boundary="outside_domain_redirect",
            response_strategy="domain_redirect",
            source="fast_path",
        )

    if _GENERIC_BOOK.search(t):
        return SupervisorDecision(
            user_intent="vague_book_request",
            confidence=0.93,
            response_strategy="ask_one_question",
            one_question_to_ask="Do you have the ISBN, title, author, or subject?",
            source="fast_path",
        )

    if router_intent == "isbn_search" or router_entities.get("isbn"):
        return SupervisorDecision(
            user_intent="isbn_collection",
            confidence=0.90,
            worker_requests=[WorkerRequest(worker="isbn_lookup", reason="ISBN provided")],
            entities=dict(router_entities),
            source="fast_path",
        )

    if _ORDER_Q.search(t) or router_intent == "order_lookup":
        return SupervisorDecision(
            user_intent="order_lookup",
            confidence=0.88,
            worker_requests=[WorkerRequest(worker="order_lookup", reason="order question")],
            entities=dict(router_entities),
            source="fast_path",
        )

    if _SHIPPING_Q.search(t) or router_intent in ("shipping_question", "shipping_price"):
        return SupervisorDecision(
            user_intent="shipping_question",
            confidence=0.88,
            worker_requests=[WorkerRequest(worker="shipping_lookup", reason="shipping")],
            source="fast_path",
        )

    if _REFUND_Q.search(t) or router_intent in ("refund_detail", "refund_status"):
        return SupervisorDecision(
            user_intent="refund_lookup",
            confidence=0.88,
            worker_requests=[WorkerRequest(worker="refund_lookup", reason="refund question")],
            entities=dict(router_entities),
            source="fast_path",
        )

    if _FACILITY_Q.search(t) or router_intent == "facility_approval":
        return SupervisorDecision(
            user_intent="facility_approval",
            confidence=0.87,
            worker_requests=[WorkerRequest(worker="facility_approval", reason="facility")],
            entities=dict(router_entities),
            source="fast_path",
        )

    if router_intent == "send_payment_link":
        return SupervisorDecision(
            user_intent="payment_link",
            confidence=0.90,
            worker_requests=[
                WorkerRequest(worker="cart_memory", reason="cart state", can_run_parallel=True),
                WorkerRequest(worker="payment_flow", reason="payment", can_run_parallel=False),
            ],
            source="fast_path",
        )

    if router_intent == "payment_execute":
        return SupervisorDecision(
            user_intent="payment_execute",
            confidence=0.92,
            worker_requests=[WorkerRequest(worker="payment_flow", reason="execute payment")],
            response_strategy="payment",
            source="fast_path",
        )

    if router_intent == "address_update":
        return SupervisorDecision(
            user_intent="address_update",
            confidence=0.90,
            worker_requests=[WorkerRequest(worker="address_update", reason="address")],
            source="fast_path",
        )

    if router_intent == "cancellation_request":
        return SupervisorDecision(
            user_intent="cancellation",
            confidence=0.90,
            worker_requests=[WorkerRequest(worker="cancellation", reason="cancel")],
            source="fast_path",
        )

    if router_intent == "greeting":
        return SupervisorDecision(
            user_intent="greeting",
            confidence=0.90,
            response_strategy="direct",
            source="fast_path",
        )

    override = _override_router_hint(t, router_intent, router_entities)
    if override:
        return override

    if router_intent and router_intent != "unknown":
        return SupervisorDecision(
            user_intent=router_intent,
            confidence=0.78,
            entities=dict(router_entities),
            source="router_hint",
        )

    return None


def _supervisor_to_intent(decision: SupervisorDecision) -> str:
    mapping = {
        "identity": "identity_question",
        "company_question": "company_question",
        "book_search": "product_search",
        "book_topic_allowed": "topic_book_search_offer",
        "isbn_collection": "isbn_search",
        "payment_link": "send_payment_link",
        "payment_execute": "payment_execute",
        "out_of_domain": "out_of_domain_question",
        "facility_approval": "facility_approval",
        "facility_restriction": "facility_restriction",
        "cancellation": "cancellation_request",
        "address_update": "address_update",
        "email_capture": "email_provided",
        "email_spell": "spell_email_request",
        "cart_memory": "memory_summary_question",
        "call_resume": "greeting",
        "customer_service": "escalation",
        "ending": "ending_thanks",
        "greeting": "greeting",
        "small_talk": "small_talk",
        "vague_book_request": "vague_book_request",
        "repeat_clarification": "repeat_clarification",
        "frustration_repair": "frustration_repair",
        "refund_lookup": "refund_detail",
        "order_lookup": "order_lookup",
    }
    return mapping.get(decision.user_intent, decision.user_intent)


async def _call_llm_supervisor(
    system: str,
    user_prompt: str,
    settings,
    sid: str = "",
) -> Optional[dict]:
    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    timeout = settings.VOICE_SUPERVISOR_TIMEOUT_MS / 1000
    model = settings.VOICE_SUPERVISOR_MODEL

    logger.info("supervisor_llm_request sid=%s model=%s", sid[:6] if sid else "?", model)

    try:
        resp = await asyncio.wait_for(
            client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_prompt},
                ],
                response_format={"type": "json_object"},
                temperature=0.2,
                max_tokens=400,
            ),
            timeout=timeout,
        )
        raw = resp.choices[0].message.content or "{}"
        parsed = json.loads(raw)
        logger.info(
            "supervisor_llm_response sid=%s intent=%s source=llm",
            sid[:6] if sid else "?",
            parsed.get("user_intent", "unknown"),
        )
        return parsed
    except (asyncio.TimeoutError, json.JSONDecodeError):
        return None
    except Exception:
        logger.exception("supervisor_llm_error")
        return None


class LLMSupervisor:
    """Eric LLM Supervisor — first semantic decision after TurnAssembler."""

    def __init__(self, settings=None):
        from ..config import get_settings
        self._settings = settings or get_settings()

    async def decide(
        self,
        session: "SessionState",
        caller_text: str,
        memory: MemoryPacket,
        state: StatePacket,
        router_intent: str = "unknown",
        router_entities: Optional[dict] = None,
    ) -> SupervisorDecision:
        settings = self._settings
        sid = session.call_sid[:6]
        entities = dict(router_entities or {})

        fast = _fast_path(caller_text, router_intent, entities, session)
        if fast:
            logger.info(
                "eric_supervisor_decision sid=%s intent=%s confidence=%.2f "
                "workers=%s mood=%s source=%s",
                sid, fast.user_intent, fast.confidence,
                [w.worker for w in fast.worker_requests], fast.customer_mood,
                fast.source,
            )
            return fast

        if not settings.VOICE_LLM_BRAIN_ENABLED:
            fb = SupervisorDecision(
                user_intent=router_intent or "unknown",
                confidence=0.75,
                entities=entities,
                source="router",
            )
            logger.info(
                "eric_supervisor_decision sid=%s intent=%s confidence=%.2f workers=[] mood=normal source=router",
                sid, fb.user_intent, fb.confidence,
            )
            return fb

        kb = retrieve_knowledge_snippets(caller_text, router_intent, session)
        kb_block = "\n".join(kb) if kb else ""

        user_prompt = (
            f"Customer turn: {caller_text}\n\n"
            f"Router hint (not final): {router_intent}\n"
            f"Entities: {json.dumps(entities)}\n\n"
            f"State:\n{state.to_context()}\n\n"
            f"Memory:\n{memory.to_supervisor_context()}\n\n"
            f"{kb_block}\n\n"
            "Respond JSON only with user_intent, confidence, customer_mood, "
            "domain_boundary, worker_requests, facts_needed, should_answer_now, "
            "should_wait_for_more_speech, response_strategy, one_question_to_ask, "
            "must_not_say, memory_updates, response_draft."
        )

        system = build_eric_brain_system_prompt()
        raw = await _call_llm_supervisor(system, user_prompt, settings, sid=sid)
        if raw:
            decision = _parse_supervisor_json(raw)
            decision.entities = entities
            if decision.user_intent == "unknown" and router_intent != "unknown":
                override = _override_router_hint(caller_text, router_intent, entities)
                if override:
                    decision = override
                else:
                    decision.user_intent = router_intent
                    decision.confidence = max(decision.confidence, 0.72)
                    decision.source = "llm_with_router_hint"
            elif decision.user_intent in (
                "book_title_search", "product_search", "book_search",
            ):
                override = _override_router_hint(caller_text, decision.user_intent, entities)
                if override:
                    decision = override
        else:
            decision = SupervisorDecision(
                user_intent=router_intent or "unknown",
                confidence=0.70,
                entities=entities,
                source="fallback",
            )

        logger.info(
            "eric_supervisor_decision sid=%s intent=%s confidence=%.2f "
            "workers=%s mood=%s source=%s",
            sid, decision.user_intent, decision.confidence,
            [w.worker for w in decision.worker_requests],
            decision.customer_mood, decision.source,
        )
        return decision


_supervisor: Optional[LLMSupervisor] = None


def get_supervisor(settings=None) -> LLMSupervisor:
    global _supervisor
    if _supervisor is None:
        _supervisor = LLMSupervisor(settings=settings)
    return _supervisor


def supervisor_intent_to_pipeline(supervisor: SupervisorDecision) -> str:
    return _supervisor_to_intent(supervisor)
