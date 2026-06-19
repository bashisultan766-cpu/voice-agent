"""
NormalizeVoiceIntent — converts a raw ASR transcript into a structured intent.

Addresses the core challenge of voice input: transcripts are noisy, informal,
and ambiguous. This tool should be called early in a turn whenever the AI needs
a structured classification before deciding which downstream tool to invoke.

Returned `intent` values map directly to the other tools:
  ORDER_LOOKUP        → GetOrder
  CATALOG_SEARCH      → SureShotCatalogSearch
  PRICE_INQUIRY       → CalculatePricing
  FACILITY_APPROVAL   → CheckFacilityApproval
  FACILITY_ORDER_CHECK→ CheckOrderFacilityRestrictions
  ADDRESS_UPDATE      → AddressUpdateInstructions
  CANCEL_ORDER        → CancelOrderRequest
  ESCALATE            → EscalateToCustomerService
  PAYMENT_LINK        → SendPaymentLink
  FACILITY_PAYMENT    → SendFacilityPaymentLink
  CALLER_INFO         → GetCallerInfo
  SAVE_NAME           → SaveCallerName
  GREETING            → no tool (pipeline handles)
  CLOSING             → no tool (pipeline handles)
  GENERAL             → no tool (AI responds directly)
"""
from __future__ import annotations

import json
import logging
from typing import Any, Literal

from pydantic import BaseModel

from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

logger = logging.getLogger(__name__)

IntentType = Literal[
    "ORDER_LOOKUP",
    "CATALOG_SEARCH",
    "PRICE_INQUIRY",
    "FACILITY_APPROVAL",
    "FACILITY_ORDER_CHECK",
    "ADDRESS_UPDATE",
    "CANCEL_ORDER",
    "ESCALATE",
    "PAYMENT_LINK",
    "FACILITY_PAYMENT",
    "CALLER_INFO",
    "SAVE_NAME",
    "GREETING",
    "CLOSING",
    "GENERAL",
]


class ExtractedEntities(BaseModel):
    order_number: str | None = None       # stripped of # and spaces, e.g. "1234"
    caller_name: str | None = None        # full name as spoken
    book_query: str | None = None         # book title / keyword
    author_name: str | None = None
    isbn: str | None = None               # digits only
    facility_name: str | None = None
    facility_state: str | None = None     # 2-letter abbreviation when determinable
    email: str | None = None
    price_context: str | None = None      # e.g. "shipping cost", "total with tax"


class NormalizedIntent(BaseModel):
    intent: IntentType
    confidence: float                      # 0.0–1.0
    cleaned_text: str                      # de-noised transcript
    language_detected: str                 # ISO 639-1, e.g. "en" | "ar"
    entities: ExtractedEntities
    reasoning: str                         # one sentence — why this intent


_SYSTEM_PROMPT = """\
You are a voice-intent classifier for a bookstore phone sales agent.
Your input is a raw speech-to-text transcript that may contain filler words,
repetitions, background noise artifacts, or non-standard number dictation
(e.g. "one two three four" instead of "1234").

Return a JSON object matching this exact schema (all fields required):
{
  "intent": "<one of the allowed intent values>",
  "confidence": <float 0.0-1.0>,
  "cleaned_text": "<de-noised, grammatically corrected version of the transcript>",
  "language_detected": "<ISO 639-1 code>",
  "entities": {
    "order_number": "<digits only, no # or spaces, or null>",
    "caller_name": "<full name or null>",
    "book_query": "<search-ready query or null>",
    "author_name": "<author full name or null>",
    "isbn": "<digits only or null>",
    "facility_name": "<full facility name or null>",
    "facility_state": "<2-letter US state or null>",
    "email": "<email address or null>",
    "price_context": "<what pricing info they want or null>"
  },
  "reasoning": "<one sentence explaining the classification>"
}

Allowed intent values:
  ORDER_LOOKUP, CATALOG_SEARCH, PRICE_INQUIRY, FACILITY_APPROVAL,
  FACILITY_ORDER_CHECK, ADDRESS_UPDATE, CANCEL_ORDER, ESCALATE,
  PAYMENT_LINK, FACILITY_PAYMENT, CALLER_INFO, SAVE_NAME,
  GREETING, CLOSING, GENERAL

Rules:
- Convert number words to digits in order_number ("one two three four" → "1234").
- Strip leading # from order numbers.
- If the caller says their name, set intent=SAVE_NAME and populate caller_name.
- Facility intents take precedence over generic ORDER_LOOKUP when a prison/jail is mentioned.
- Default to GENERAL when uncertain rather than guessing a specific intent.
- confidence reflects how unambiguous the transcript is (1.0 = crystal clear).
"""


class NormalizeVoiceIntentTool(BaseTool):
    name = "normalize_voice_intent"
    description = (
        "Convert a raw voice transcript into a structured intent with extracted entities. "
        "Call this at the start of a turn when the caller's request is ambiguous or contains "
        "noisy speech, number dictation, or mixed-language input. "
        "The returned `intent` field tells you which downstream tool to call next."
    )
    parameters = {
        "type": "object",
        "properties": {
            "raw_transcript": {
                "type": "string",
                "description": "The raw speech-to-text string exactly as received from Twilio/ASR",
            },
            "conversation_context": {
                "type": "string",
                "description": (
                    "Optional brief context about the current conversation state, "
                    "e.g. 'caller was asked for order number' or 'browsing products'. "
                    "Helps disambiguate short replies like 'yes' or '1234'."
                ),
            },
        },
        "required": ["raw_transcript"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        raw_transcript = args.get("raw_transcript", "").strip()
        conversation_context = args.get("conversation_context", "")

        if not raw_transcript:
            return ToolResult(
                success=False,
                data={},
                voice_summary="",
                error="raw_transcript is required",
            )

        user_content = f"Transcript: {raw_transcript}"
        if conversation_context:
            user_content += f"\nContext: {conversation_context}"

        from ...ai.client import get_openai_client
        openai_client = get_openai_client(context.agent_config.openai_api_key)

        model = context.agent_config.openai_model or "gpt-4o-mini"

        try:
            response = await openai_client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
                response_format={"type": "json_object"},
                temperature=0.0,
                max_tokens=400,
            )
        except Exception as exc:
            logger.error("NormalizeVoiceIntent OpenAI call failed: %s", exc, exc_info=True)
            return ToolResult(
                success=False,
                data={},
                voice_summary="",
                error=f"Classification failed: {exc}",
            )

        raw_json = response.choices[0].message.content or "{}"
        try:
            parsed = json.loads(raw_json)
            normalized = NormalizedIntent(**parsed)
        except Exception as exc:
            logger.warning(
                "NormalizeVoiceIntent parse error — raw=%r err=%s", raw_json[:200], exc
            )
            normalized = NormalizedIntent(
                intent="GENERAL",
                confidence=0.5,
                cleaned_text=raw_transcript,
                language_detected=context.agent_config.language.split(",")[0],
                entities=ExtractedEntities(),
                reasoning="Parse error — defaulting to GENERAL",
            )

        logger.info(
            "NormalizeVoiceIntent: intent=%s conf=%.2f entities=%s",
            normalized.intent,
            normalized.confidence,
            normalized.entities.model_dump(exclude_none=True),
        )

        return ToolResult(
            success=True,
            data=normalized.model_dump(),
            voice_summary="",  # this tool feeds data to the AI, not the caller
        )


registry.register(NormalizeVoiceIntentTool())
