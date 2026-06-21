from __future__ import annotations
import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from app.core.cache import cache_get, cache_set
from app.tools.base import ToolContext
from app.tools.registry import ToolRegistry
from app.voice.intent import (
    Intent,
    IntentResult,
    SafetyCheckResult,
    check_safety_policy_async,
    classify_intent,
    classify_intent_async,
    entities_to_dict,
)
from app.voice.latency import (
    global_turn_timeout_secs,
    shopify_order_timeout_secs,
    shopify_product_timeout_secs,
    tts_timeout_secs,
)
from app.voice.llm import run_agentic_loop
from app.voice.tracer import TurnTracer, VoiceTurnTrace
from app.voice.tts import synthesize_speech, truncate_for_voice

logger = logging.getLogger("voice.orchestrator")

_INSTANT_REPLIES: Dict[Intent, str] = {
    Intent.GREETING: "Hi there! Welcome to SureShot Books. How can I help you today?",
    Intent.FAREWELL: "Thank you for calling! Have a wonderful day. Goodbye!",
}

_FILLER_BY_INTENT: Dict[Intent, str] = {
    Intent.PRODUCT_SEARCH: "Let me search our catalog for that.",
    Intent.ORDER_LOOKUP: "Sure, let me pull up that order for you.",
    Intent.CHECKOUT: "I'll get that set up for you.",
    Intent.RECOMMENDATION: "Let me find some great options for you.",
    Intent.EMAIL_CAPTURE: "Got it, let me update that.",
    Intent.OTHER: "One moment please.",
}

_FALLBACK_TEXT = (
    "I'm still looking that up. Could you give me just a moment, or try calling back?"
)
_SAFETY_FALLBACK = (
    "I'm not able to help with that request. "
    "Is there something else I can assist you with?"
)
_GENERIC_FALLBACK = "I'm having trouble right now. Please try again."


@dataclass
class OrchestratorResult:
    text: str
    audio_path: Optional[str]
    tool_calls: List[Dict[str, Any]]
    response_mode: str          # "instant" | "llm" | "fallback"
    fallback_reason: Optional[str]
    trace: VoiceTurnTrace
    latency_ms: int
    intent: str = "unknown"
    entities: Dict[str, Any] = field(default_factory=dict)
    tool_results: Dict[str, Any] = field(default_factory=dict)
    partial_results: Dict[str, Any] = field(default_factory=dict)
    final_response: str = ""
    fallback_used: bool = False
    latency_breakdown: Dict[str, int] = field(default_factory=dict)
    filler_text: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Serializable form suitable for Redis storage and TwiML building."""
        return {
            "text": self.text,
            "audio_path": self.audio_path,
            "tool_calls": self.tool_calls,
            "latency_ms": self.latency_ms,
            "response_mode": self.response_mode,
            "fallback_reason": self.fallback_reason,
            "intent": self.intent,
            "entities": self.entities,
            "tool_results": self.tool_results,
            "partial_results": self.partial_results,
            "final_response": self.final_response or self.text,
            "fallback_used": self.fallback_used,
            "latency_breakdown": self.latency_breakdown,
            "filler_text": self.filler_text,
        }


@dataclass
class _BootstrapResult:
    intent_result: IntentResult
    history: List[Dict[str, Any]]
    safety: SafetyCheckResult
    latency_ms: int


class ParallelVoiceOrchestrator:
    """
    Budgeted speculative parallel voice turn orchestrator.

    Bootstrap (always parallel)
    ───────────────────────────
    • intent classification
    • entity extraction (inside intent)
    • conversation state fetch
    • safety / policy check

    Conditional parallel work
    ─────────────────────────
    • Shopify product search (ISBN / title detected)
    • Shopify order lookup (order number / email detected)
    • OpenAI response generation
    • TTS preparation for filler + final response

    Global budget: 12 s. Per-tool budgets enforced via asyncio.timeout.
    """

    def __init__(
        self,
        agent_id: str,
        tenant_id: str,
        call_sid: str,
        system_prompt: str,
        tool_registry: ToolRegistry,
        tool_context: ToolContext,
        llm_model: str = "gpt-4o-mini",
        tts_voice: str = "alloy",
        openai_api_key: Optional[str] = None,
        use_openai_tts: bool = True,
    ) -> None:
        self.agent_id = agent_id
        self.tenant_id = tenant_id
        self.call_sid = call_sid
        self.system_prompt = system_prompt
        self.registry = tool_registry
        self.ctx = tool_context
        self.llm_model = llm_model
        self.tts_voice = tts_voice
        self.openai_api_key = openai_api_key
        self.use_openai_tts = use_openai_tts

    def _history_key(self) -> str:
        return f"conv:history:{self.call_sid}"

    async def _load_history(self) -> List[Dict[str, Any]]:
        return (await cache_get(self._history_key())) or []

    async def _save_history(
        self,
        user_msg: str,
        assistant_msg: str,
        history: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        if history is None:
            history = await self._load_history()
        else:
            history = list(history)
        history.append({"role": "user", "content": user_msg})
        history.append({"role": "assistant", "content": assistant_msg})
        if len(history) > 40:
            history = history[-40:]
        await cache_set(self._history_key(), history, ttl=3600)

    @staticmethod
    def _cancel_tasks(tasks: Dict[str, asyncio.Task]) -> None:
        for task in tasks.values():
            if not task.done():
                task.cancel()

    @staticmethod
    def _cancel_task(task: Optional[asyncio.Task]) -> None:
        if task is not None and not task.done():
            task.cancel()

    async def _bootstrap_parallel(self, transcript: str, tracer: TurnTracer) -> _BootstrapResult:
        """Run intent, history load, and safety check concurrently."""
        start = time.monotonic()

        async def _intent() -> IntentResult:
            return await classify_intent_async(transcript)

        async def _history() -> List[Dict[str, Any]]:
            return await self._load_history()

        async def _safety() -> SafetyCheckResult:
            return await check_safety_policy_async(transcript)

        intent_result, history, safety = await asyncio.gather(
            _intent(),
            _history(),
            _safety(),
        )
        elapsed = int((time.monotonic() - start) * 1000)
        tracer.record_step("bootstrap_parallel", elapsed, success=True)
        return _BootstrapResult(
            intent_result=intent_result,
            history=history,
            safety=safety,
            latency_ms=elapsed,
        )

    async def _run_tool_with_budget(
        self,
        name: str,
        args: Dict[str, Any],
        tool_trace,
        timeout_secs: float,
    ) -> str:
        try:
            async with asyncio.timeout(timeout_secs):
                result = await self.registry.execute(name, self.ctx, args)
            tool_trace.mark_complete(failed=False)
            return result
        except TimeoutError:
            tool_trace.mark_complete(
                failed=True,
                error="timeout",
                fallback_reason="tool_timeout",
            )
            return json.dumps({"error": f"{name} timed out"})
        except Exception as exc:
            tool_trace.mark_complete(failed=True, error=str(exc)[:120])
            return json.dumps({"error": str(exc)})

    def _launch_conditional_tools(
        self,
        intent_result: IntentResult,
        tracer: TurnTracer,
    ) -> Dict[str, asyncio.Task]:
        """
        Launch speculative Shopify / recommendation tools based on entities.
        Returns {cache_key: Task}.
        """
        tasks: Dict[str, asyncio.Task] = {}
        entities = intent_result.entities

        should_product_search = bool(
            entities.isbn
            or (
                entities.product_query
                and intent_result.intent
                in (Intent.PRODUCT_SEARCH, Intent.RECOMMENDATION, Intent.CHECKOUT)
            )
        )
        if should_product_search:
            query = entities.isbn or entities.product_query or ""
            args: Dict[str, Any] = {"query": query, "limit": 5}
            key = f"product_search:{json.dumps(args, sort_keys=True)}"
            tt = tracer.tool_launched("product_search", args)
            tasks[key] = asyncio.create_task(
                self._run_tool_with_budget(
                    "product_search",
                    args,
                    tt,
                    shopify_product_timeout_secs(),
                ),
                name=f"prefetch:{key}",
            )

        if entities.order_number or (
            intent_result.intent == Intent.ORDER_LOOKUP and entities.email
        ):
            args = {}
            if entities.order_number:
                args = {"order_name": entities.order_number}
            elif entities.email:
                args = {"email": entities.email}
            if args:
                key = f"order_lookup:{json.dumps(args, sort_keys=True)}"
                tt = tracer.tool_launched("order_lookup", args)
                tasks[key] = asyncio.create_task(
                    self._run_tool_with_budget(
                        "order_lookup",
                        args,
                        tt,
                        shopify_order_timeout_secs(),
                    ),
                    name=f"prefetch:{key}",
                )

        if intent_result.intent == Intent.RECOMMENDATION and entities.product_query:
            args = {"interest": entities.product_query, "limit": 3}
            key = f"recommendation:{json.dumps(args, sort_keys=True)}"
            tt = tracer.tool_launched("recommendation", args)
            tasks[key] = asyncio.create_task(
                self._run_tool_with_budget(
                    "recommendation",
                    args,
                    tt,
                    shopify_product_timeout_secs(),
                ),
                name=f"prefetch:{key}",
            )

        return tasks

    def _make_cached_executor(
        self,
        prefetch_tasks: Dict[str, asyncio.Task],
        tracer: TurnTracer,
    ) -> Callable:
        async def execute(name: str, args: Dict[str, Any]) -> str:
            cache_key = f"{name}:{json.dumps(args, sort_keys=True)}"
            task = prefetch_tasks.get(cache_key)
            if task is not None and task.done() and not task.cancelled():
                try:
                    cached = task.result()
                    for tt in tracer._tool_traces:
                        if tt.name == name and not tt.from_cache:
                            tt.from_cache = True
                            break
                    return cached
                except Exception:
                    pass

            tt = tracer.tool_launched(name, args)
            timeout = (
                shopify_order_timeout_secs()
                if name == "order_lookup"
                else shopify_product_timeout_secs()
            )
            return await self._run_tool_with_budget(name, args, tt, timeout)

        return execute

    async def _collect_tool_results(
        self,
        prefetch_tasks: Dict[str, asyncio.Task],
        *,
        cancel_unused: bool = True,
    ) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        tool_results: Dict[str, Any] = {}
        partial_results: Dict[str, Any] = {}

        for key, task in prefetch_tasks.items():
            if task.done() and not task.cancelled():
                try:
                    payload = task.result()
                    tool_results[key] = payload
                    try:
                        partial_results[key] = json.loads(payload)
                    except json.JSONDecodeError:
                        partial_results[key] = payload
                except Exception as exc:
                    partial_results[key] = {"error": str(exc)}
            elif not task.done():
                partial_results[key] = {"status": "pending"}
                if cancel_unused:
                    task.cancel()

        return tool_results, partial_results

    async def _run_llm(
        self,
        transcript: str,
        history: List[Dict[str, Any]],
        prefetch_tasks: Dict[str, asyncio.Task],
        tracer: TurnTracer,
    ) -> Tuple[str, List[Dict[str, Any]]]:
        executor = self._make_cached_executor(prefetch_tasks, tracer)
        start = time.monotonic()
        try:
            response_text, tool_calls = await run_agentic_loop(
                system_prompt=self.system_prompt,
                conversation_history=history,
                user_message=transcript,
                tool_schemas=self.registry.schemas(),
                tool_executor=executor,
                model=self.llm_model,
                api_key=self.openai_api_key,
            )
            tracer.record_step("llm", int((time.monotonic() - start) * 1000), success=True)
            return response_text, tool_calls
        except TimeoutError:
            tracer.record_step(
                "llm",
                int((time.monotonic() - start) * 1000),
                success=False,
                fallback_reason="llm_timeout",
            )
            raise

    async def _maybe_tts(self, text: str, step_name: str, tracer: TurnTracer) -> Optional[str]:
        if not self.use_openai_tts or not text.strip():
            return None
        start = time.monotonic()
        try:
            path = await synthesize_speech(
                text,
                voice=self.tts_voice,
                api_key=self.openai_api_key,
            )
            tracer.record_step(
                step_name,
                int((time.monotonic() - start) * 1000),
                success=path is not None,
            )
            return path
        except Exception:
            tracer.record_step(
                step_name,
                int((time.monotonic() - start) * 1000),
                success=False,
                fallback_reason="tts_failed",
            )
            return None

    def _build_result(
        self,
        *,
        start: float,
        tracer: TurnTracer,
        text: str,
        audio_path: Optional[str],
        tool_calls: List[Dict[str, Any]],
        response_mode: str,
        fallback_reason: Optional[str],
        intent_result: IntentResult,
        tool_results: Dict[str, Any],
        partial_results: Dict[str, Any],
        filler_text: Optional[str] = None,
    ) -> OrchestratorResult:
        entities = entities_to_dict(intent_result.entities)
        trace = tracer.finalize()
        return OrchestratorResult(
            text=text,
            audio_path=audio_path,
            tool_calls=tool_calls,
            response_mode=response_mode,
            fallback_reason=fallback_reason,
            trace=trace,
            latency_ms=int((time.monotonic() - start) * 1000),
            intent=intent_result.intent.value,
            entities=entities,
            tool_results=tool_results,
            partial_results=partial_results,
            final_response=text,
            fallback_used=response_mode == "fallback",
            latency_breakdown=trace.latency_breakdown,
            filler_text=filler_text,
        )

    async def process_turn(self, transcript: str) -> OrchestratorResult:
        """Process one voice turn end-to-end with parallel orchestration."""
        start = time.monotonic()
        tracer = TurnTracer(
            call_sid=self.call_sid,
            agent_id=self.agent_id,
            tenant_id=self.tenant_id,
            transcript=transcript,
        )

        try:
            async with asyncio.timeout(global_turn_timeout_secs()):
                return await self._process_turn_inner(transcript, start, tracer)
        except TimeoutError:
            tracer.set_response_mode("fallback", "global_timeout")
            return self._build_result(
                start=start,
                tracer=tracer,
                text=_GENERIC_FALLBACK,
                audio_path=None,
                tool_calls=[],
                response_mode="fallback",
                fallback_reason="global_timeout",
                intent_result=classify_intent(transcript),
                tool_results={},
                partial_results={},
            )
        except Exception as exc:
            logger.exception(
                "voice_turn_failed",
                extra={"call_sid": self.call_sid, "error": str(exc)},
            )
            tracer.set_response_mode("fallback", "unexpected_error")
            return self._build_result(
                start=start,
                tracer=tracer,
                text=_GENERIC_FALLBACK,
                audio_path=None,
                tool_calls=[],
                response_mode="fallback",
                fallback_reason="unexpected_error",
                intent_result=classify_intent(transcript),
                tool_results={},
                partial_results={"error": str(exc)[:200]},
            )

    async def _process_turn_inner(
        self,
        transcript: str,
        start: float,
        tracer: TurnTracer,
    ) -> OrchestratorResult:
        prefetch_tasks: Dict[str, asyncio.Task] = {}
        llm_task: Optional[asyncio.Task] = None
        filler_tts_task: Optional[asyncio.Task] = None

        try:
            bootstrap = await self._bootstrap_parallel(transcript, tracer)
            intent_result = bootstrap.intent_result
            entities = entities_to_dict(intent_result.entities)
            filler_text = _FILLER_BY_INTENT.get(
                intent_result.intent, _FILLER_BY_INTENT[Intent.OTHER]
            )

            tracer.set_intent(
                intent=intent_result.intent.value,
                confidence=intent_result.confidence,
                entities=entities,
            )

            if not bootstrap.safety.allowed:
                tracer.set_response_mode("fallback", bootstrap.safety.reason)
                audio_path = await self._maybe_tts(_SAFETY_FALLBACK, "tts_safety", tracer)
                return self._build_result(
                    start=start,
                    tracer=tracer,
                    text=_SAFETY_FALLBACK,
                    audio_path=audio_path,
                    tool_calls=[],
                    response_mode="fallback",
                    fallback_reason=bootstrap.safety.reason,
                    intent_result=intent_result,
                    tool_results={},
                    partial_results={},
                )

            if intent_result.is_instant and intent_result.intent in _INSTANT_REPLIES:
                text = _INSTANT_REPLIES[intent_result.intent]
                tracer.set_response_mode("instant")
                tts_task = asyncio.create_task(self._maybe_tts(text, "tts_instant", tracer))
                history_task = asyncio.create_task(
                    self._save_history(transcript, text, bootstrap.history)
                )
                gathered = await asyncio.gather(tts_task, history_task, return_exceptions=True)
                audio_path = gathered[0] if isinstance(gathered[0], str) else None
                return self._build_result(
                    start=start,
                    tracer=tracer,
                    text=text,
                    audio_path=audio_path,
                    tool_calls=[],
                    response_mode="instant",
                    fallback_reason=None,
                    intent_result=intent_result,
                    tool_results={},
                    partial_results={},
                )

            prefetch_tasks.update(self._launch_conditional_tools(intent_result, tracer))

            if self.use_openai_tts:
                filler_tts_task = asyncio.create_task(
                    self._maybe_tts(filler_text, "tts_filler", tracer),
                    name="tts_filler",
                )

            llm_task = asyncio.create_task(
                self._run_llm(transcript, bootstrap.history, prefetch_tasks, tracer),
                name="llm",
            )

            response_text = ""
            llm_tool_calls: List[Dict[str, Any]] = []
            fallback_reason: Optional[str] = None
            response_mode = "llm"

            try:
                response_text, llm_tool_calls = await llm_task
                tracer.set_response_mode("llm")
            except TimeoutError:
                response_mode = "fallback"
                fallback_reason = "llm_timeout"
                tracer.set_response_mode("fallback", fallback_reason)
                tool_results, partial_results = await self._collect_tool_results(
                    prefetch_tasks,
                    cancel_unused=True,
                )
                response_text = _FALLBACK_TEXT if partial_results else _GENERIC_FALLBACK
                audio_path = await self._maybe_tts(response_text, "tts_fallback", tracer)
                return self._build_result(
                    start=start,
                    tracer=tracer,
                    text=response_text,
                    audio_path=audio_path,
                    tool_calls=[],
                    response_mode=response_mode,
                    fallback_reason=fallback_reason,
                    intent_result=intent_result,
                    tool_results=tool_results,
                    partial_results=partial_results,
                    filler_text=filler_text,
                )
            finally:
                self._cancel_task(filler_tts_task)
                filler_tts_task = None

            tool_results, partial_results = await self._collect_tool_results(prefetch_tasks)
            voice_text = truncate_for_voice(response_text)

            tts_task = asyncio.create_task(
                self._maybe_tts(voice_text, "tts_final", tracer),
                name="tts_final",
            )
            history_task = asyncio.create_task(
                self._save_history(transcript, response_text, bootstrap.history),
                name="save_history",
            )

            gathered = await asyncio.gather(tts_task, history_task, return_exceptions=True)
            audio_path = gathered[0] if isinstance(gathered[0], str) else None

            return self._build_result(
                start=start,
                tracer=tracer,
                text=voice_text,
                audio_path=audio_path,
                tool_calls=llm_tool_calls,
                response_mode=response_mode,
                fallback_reason=fallback_reason,
                intent_result=intent_result,
                tool_results=tool_results,
                partial_results=partial_results,
                filler_text=filler_text,
            )
        finally:
            self._cancel_task(llm_task)
            self._cancel_task(filler_tts_task)
            self._cancel_tasks(prefetch_tasks)
