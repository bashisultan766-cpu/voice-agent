"""
Tool: normalize_voice_intent
Version: v2

Purpose:
    Convert a raw ASR (speech-to-text) transcript into a structured intent
    with extracted entities. Designed for the first step in any ambiguous turn
    before calling a downstream action tool.

    ASR output is noisy: filler words, number dictation, repeated phrases,
    mispronunciations. This tool produces a clean, typed intent so the agent
    can call the right downstream tool with the right arguments.

Intent → downstream tool mapping:
    ORDER_LOOKUP         → get_order
    CATALOG_SEARCH       → sure_shot_catalog_search
    PRICE_INQUIRY        → calculate_pricing
    FACILITY_APPROVAL    → check_facility_approval
    FACILITY_ORDER_CHECK → check_order_facility_restrictions
    ADDRESS_UPDATE       → address_update_instructions
    CANCEL_ORDER         → cancel_order_request
    ESCALATE             → escalate_to_customer_service
    PAYMENT_LINK         → send_payment_link
    FACILITY_PAYMENT     → send_facility_payment_link
    CALLER_INFO          → get_caller_info
    SAVE_NAME            → save_caller_name
    GREETING             → handled by pipeline (no tool)
    CLOSING              → handled by pipeline (no tool)
    GENERAL              → AI responds directly (no tool)

Example request:
    {
        "raw_transcript": "yeah uh i wanna check on my order like one two three four",
        "conversation_context": "caller was browsing books"
    }

Example response (in ToolResult.data):
    {
        "success": true,
        "message": "Intent classified as ORDER_LOOKUP (confidence 0.92)",
        "data": {
            "intent": "ORDER_LOOKUP",
            "confidence": 0.92,
            "cleaned_text": "I want to check on my order 1234.",
            "language_detected": "en",
            "entities": {
                "order_number": "1234",
                "caller_name": null,
                "book_query": null,
                "author_name": null,
                "isbn": null,
                "facility_name": null,
                "facility_state": null,
                "email": null,
                "price_context": null
            },
            "reasoning": "Caller wants to look up an order and dictated a 4-digit number.",
            "next_tool": "get_order"
        },
        "error": null
    }
"""
from __future__ import annotations

import json
import logging
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator

from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

_OPENAI_TIMEOUT = 5.0      # hard cap — voice call budget
_FALLBACK_INTENT = "GENERAL"
_MAX_TRANSCRIPT = 2_000    # chars — reject pathological inputs early

# ── Intent enum ───────────────────────────────────────────────────────────────


class VoiceIntent(str, Enum):
    ORDER_LOOKUP = "ORDER_LOOKUP"
    CATALOG_SEARCH = "CATALOG_SEARCH"
    PRICE_INQUIRY = "PRICE_INQUIRY"
    FACILITY_APPROVAL = "FACILITY_APPROVAL"
    FACILITY_ORDER_CHECK = "FACILITY_ORDER_CHECK"
    ADDRESS_UPDATE = "ADDRESS_UPDATE"
    CANCEL_ORDER = "CANCEL_ORDER"
    ESCALATE = "ESCALATE"
    PAYMENT_LINK = "PAYMENT_LINK"
    FACILITY_PAYMENT = "FACILITY_PAYMENT"
    CALLER_INFO = "CALLER_INFO"
    SAVE_NAME = "SAVE_NAME"
    GREETING = "GREETING"
    CLOSING = "CLOSING"
    GENERAL = "GENERAL"


# next tool hint — maps intent to the tool name the agent should call next
_NEXT_TOOL: dict[str, str] = {
    "ORDER_LOOKUP": "get_order",
    "CATALOG_SEARCH": "sure_shot_catalog_search",
    "PRICE_INQUIRY": "calculate_pricing",
    "FACILITY_APPROVAL": "check_facility_approval",
    "FACILITY_ORDER_CHECK": "check_order_facility_restrictions",
    "ADDRESS_UPDATE": "address_update_instructions",
    "CANCEL_ORDER": "cancel_order_request",
    "ESCALATE": "escalate_to_customer_service",
    "PAYMENT_LINK": "send_payment_link",
    "FACILITY_PAYMENT": "send_facility_payment_link",
    "CALLER_INFO": "get_caller_info",
    "SAVE_NAME": "save_caller_name",
    "GREETING": "",
    "CLOSING": "",
    "GENERAL": "",
}

# ── Pydantic models ───────────────────────────────────────────────────────────


class NormalizeRequest(BaseModel):
    """
    Input schema for normalize_voice_intent.
    Validated before the OpenAI call — rejects bad inputs fast.
    """

    raw_transcript: str = Field(..., description="Raw ASR string from Twilio/STT")
    conversation_context: Optional[str] = Field(
        None,
        max_length=500,
        description="Optional context about the current conversation state",
    )

    @field_validator("raw_transcript")
    @classmethod
    def check_transcript(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("raw_transcript cannot be empty")
        if len(v) > _MAX_TRANSCRIPT:
            raise ValueError(f"raw_transcript exceeds {_MAX_TRANSCRIPT} characters")
        return v


class VoiceEntities(BaseModel):
    """Entities extracted from the transcript."""

    order_number: Optional[str] = None    # digits only, no # or spaces
    caller_name: Optional[str] = None     # full name as spoken
    book_query: Optional[str] = None      # search-ready title/keyword
    author_name: Optional[str] = None     # author full name
    isbn: Optional[str] = None            # digits only
    facility_name: Optional[str] = None   # full correctional facility name
    facility_state: Optional[str] = None  # 2-letter US state or full name
    email: Optional[str] = None           # email address
    price_context: Optional[str] = None   # e.g. "shipping cost", "total"


class NormalizeResponseData(BaseModel):
    """Structured intent result."""

    intent: str                            # VoiceIntent value
    confidence: float = Field(ge=0.0, le=1.0)
    cleaned_text: str
    language_detected: str                 # ISO 639-1
    entities: VoiceEntities
    reasoning: str                         # one sentence
    next_tool: str                         # suggested downstream tool name


# ── System prompt ─────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """\
You are a voice-intent classifier for a bookstore phone sales agent.

Your input is a raw speech-to-text transcript. It may contain:
- Filler words ("uh", "um", "like", "you know")
- Repeated phrases from ASR errors
- Numbers spoken as words ("one two three four" = 1234)
- Background noise artifacts

Return a JSON object with EXACTLY these fields (all required):

{
  "intent": "<one of the allowed values below>",
  "confidence": <float 0.0–1.0>,
  "cleaned_text": "<cleaned, grammatically correct version of the transcript>",
  "language_detected": "<ISO 639-1 code, e.g. 'en' or 'ar'>",
  "entities": {
    "order_number": "<digits only, no # or spaces — or null>",
    "caller_name": "<full name as spoken — or null>",
    "book_query": "<book title or keyword — or null>",
    "author_name": "<author full name — or null>",
    "isbn": "<digits only — or null>",
    "facility_name": "<full correctional facility name — or null>",
    "facility_state": "<2-letter US state — or null>",
    "email": "<email address — or null>",
    "price_context": "<what pricing info they want — or null>"
  },
  "reasoning": "<one sentence explaining classification>"
}

ALLOWED INTENT VALUES (use EXACTLY these strings):
  ORDER_LOOKUP, CATALOG_SEARCH, PRICE_INQUIRY, FACILITY_APPROVAL,
  FACILITY_ORDER_CHECK, ADDRESS_UPDATE, CANCEL_ORDER, ESCALATE,
  PAYMENT_LINK, FACILITY_PAYMENT, CALLER_INFO, SAVE_NAME,
  GREETING, CLOSING, GENERAL

CLASSIFICATION RULES:
1. Convert spoken numbers to digits in order_number ("one two three four" → "1234").
2. Strip leading # from order numbers.
3. If caller says their name: intent=SAVE_NAME, populate caller_name.
4. Facility context (prison/jail mentioned) → FACILITY_APPROVAL or FACILITY_PAYMENT.
5. Cancel/refund keywords → CANCEL_ORDER.
6. Address change/update → ADDRESS_UPDATE.
7. "How much" / pricing question → PRICE_INQUIRY.
8. Default to GENERAL when truly ambiguous (confidence < 0.5).
9. confidence = 1.0 only when the transcript is crystal clear.
"""

# ── Tool implementation ───────────────────────────────────────────────────────


class NormalizeVoiceIntentTool(BaseTool):
    name = "normalize_voice_intent"
    description = (
        "Convert a raw voice transcript into a structured intent with extracted entities. "
        "Call this when the caller's input is ambiguous, contains spoken numbers, "
        "filler words, or mixed-language content. "
        "The returned `intent` field tells you which tool to call next."
    )
    parameters = {
        "type": "object",
        "properties": {
            "raw_transcript": {
                "type": "string",
                "description": "The raw speech-to-text string exactly as received from ASR",
            },
            "conversation_context": {
                "type": "string",
                "description": (
                    "Optional: brief description of the current conversation state "
                    "(e.g. 'caller was asked for their order number'). "
                    "Helps disambiguate short replies like 'yes', '1234', or a name."
                ),
            },
        },
        "required": ["raw_transcript"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        # ── 1. Validate input ─────────────────────────────────────────────────
        try:
            req = NormalizeRequest(**args)
        except Exception as exc:
            return self.error_result(
                voice_summary="",
                error=f"Invalid input: {exc}",
                message="normalize_voice_intent received invalid arguments",
            )

        # ── 2. Call OpenAI ────────────────────────────────────────────────────
        user_content = f"Transcript: {req.raw_transcript}"
        if req.conversation_context:
            user_content += f"\nContext: {req.conversation_context}"

        from ..ai.client import get_openai_client  # moved from app/ai/tools_v2/ → app/tools/
        client = get_openai_client(context.agent_config.openai_api_key)
        model = context.agent_config.openai_model or "gpt-4o-mini"

        try:
            import asyncio
            response = await asyncio.wait_for(
                client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": _SYSTEM_PROMPT},
                        {"role": "user", "content": user_content},
                    ],
                    response_format={"type": "json_object"},
                    temperature=0.0,
                    max_tokens=400,
                ),
                timeout=_OPENAI_TIMEOUT,
            )
        except TimeoutError:
            logger.warning("normalize_voice_intent: OpenAI call timed out after %.1fs", _OPENAI_TIMEOUT)
            return self._fallback(req.raw_transcript, "OpenAI call timed out")
        except Exception as exc:
            logger.error("normalize_voice_intent: OpenAI call failed: %s", exc, exc_info=True)
            return self._fallback(req.raw_transcript, str(exc))

        # ── 3. Parse response ─────────────────────────────────────────────────
        raw_json = response.choices[0].message.content or "{}"
        try:
            parsed = json.loads(raw_json)
            intent_str = parsed.get("intent", _FALLBACK_INTENT)
            # Validate intent is a known value
            try:
                VoiceIntent(intent_str)
            except ValueError:
                intent_str = _FALLBACK_INTENT

            entities = VoiceEntities(**parsed.get("entities", {}))
            result_data = NormalizeResponseData(
                intent=intent_str,
                confidence=float(parsed.get("confidence", 0.5)),
                cleaned_text=parsed.get("cleaned_text", req.raw_transcript),
                language_detected=parsed.get("language_detected", "en"),
                entities=entities,
                reasoning=parsed.get("reasoning", ""),
                next_tool=_NEXT_TOOL.get(intent_str, ""),
            )
        except Exception as exc:
            logger.warning(
                "normalize_voice_intent: parse error (raw=%r): %s",
                raw_json[:200],
                exc,
            )
            return self._fallback(req.raw_transcript, f"Parse error: {exc}")

        # ── 4. Log and return ─────────────────────────────────────────────────
        logger.info(
            "normalize_voice_intent: intent=%s conf=%.2f next=%s entities=%s",
            result_data.intent,
            result_data.confidence,
            result_data.next_tool,
            entities.model_dump(exclude_none=True),
        )

        return ToolResult(
            success=True,
            data={
                "success": True,
                "message": (
                    f"Intent classified as {result_data.intent} "
                    f"(confidence {result_data.confidence:.2f})"
                ),
                "data": result_data.model_dump(),
                "error": None,
            },
            voice_summary="",  # pre-processing tool — not spoken to caller
        )

    # ── Fallback ──────────────────────────────────────────────────────────────

    def _fallback(self, raw: str, error_detail: str) -> ToolResult:
        """Return GENERAL intent on any failure so the agent can still respond."""
        fallback_data = NormalizeResponseData(
            intent=_FALLBACK_INTENT,
            confidence=0.0,
            cleaned_text=raw,
            language_detected="en",
            entities=VoiceEntities(),
            reasoning=f"Fallback due to classification error: {error_detail}",
            next_tool="",
        )
        return ToolResult(
            success=False,
            data={
                "success": False,
                "message": "Intent classification failed — defaulting to GENERAL",
                "data": fallback_data.model_dump(),
                "error": error_detail,
            },
            voice_summary="",
            error=error_detail,
        )


# ── Self-register ─────────────────────────────────────────────────────────────

registry.register(NormalizeVoiceIntentTool())
