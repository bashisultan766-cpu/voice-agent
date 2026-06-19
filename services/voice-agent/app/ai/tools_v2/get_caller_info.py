"""
Tool: get_caller_info
Version: v2

Purpose:
    Look up a caller's profile by their phone number before the conversation
    starts. Returns identity data, call history metadata, and a greeting hint
    that tells the agent how to open the call appropriately.

SAFE ARCHITECTURE PHASE — CONSTRAINTS:
    - READ-ONLY: no writes, no mutations, no side effects
    - ZERO external calls: mock data only
    - LIGHTWEIGHT: sync mock path, sub-millisecond lookup
    - voice_summary = "" (data tool — AI uses the data, not a TTS string)

    USE_REAL_CALLER_DB = False  →  MockCallerRepository  (active)
    USE_REAL_CALLER_DB = True   →  CallerProfileClient   (disabled)

Data flow:

    ┌─────────────────────────────────────────────────────────────────┐
    │  GetCallerInfoTool.execute()                                    │
    │    ↓ validate + normalise phone number                          │
    │    ↓ _resolve_caller_info()                                     │
    │         ├─ USE_REAL_CALLER_DB=False → MockCallerRepository      │
    │         │    (sync, in-memory, ~0ms)                            │
    │         └─ USE_REAL_CALLER_DB=True  → CallerProfileClient       │
    │              (disabled → falls back to mock)                    │
    │    ↓ assemble GetCallerInfoData + metadata                      │
    │    ↓ ToolResult (voice_summary="", data feeds AI logic)         │
    └─────────────────────────────────────────────────────────────────┘

Confidence levels:
    high    (≥ 0.90)  — exact DB match, name confirmed
    medium  (≥ 0.60)  — DB match, name may need verbal confirmation
    low     (≥ 0.30)  — partial match, treat as probable returning caller
    unknown (< 0.30)  — no match, treat as new caller

Mock scenarios (keyed on last digit of normalised phone):
    0–2  → Returning caller, high confidence, name known
    3–5  → Returning caller, medium confidence, name known
    6–7  → Returning caller, low confidence, name unknown
    8–9  → New caller, confidence = 0.0

Example request:
    { "phone_number": "+15551234560" }
    { "phone_number": "5551234560" }

Example response (ToolResult.data):
    {
        "success": true,
        "message": "Caller profile found (high confidence).",
        "data": {
            "found": true,
            "is_new_caller": false,
            "caller_name": "Marcus Williams",
            "first_name": "Marcus",
            "call_count": 7,
            "last_call_date": "2026-06-12",
            "past_purchases": ["A Thug's Heartbeat x1", "Tears of a Hustler x2"],
            "preferred_language": "en",
            "confidence": 0.97,
            "confidence_level": "high",
            "confidence_reason": "Exact phone match in caller profile database.",
            "should_ask_for_name": false,
            "greeting_hint": "Returning caller. Safe to address as Marcus.",
            "metadata": {
                "source": "mock",
                "lookup_ms": 0.04,
                "phone_e164": "+15551234560",
                "phone_log_safe": "+15***60"
            }
        },
        "error": null
    }
"""
from __future__ import annotations

import time
import logging
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from ..common.validators import normalize_phone, is_valid_e164
from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# FEATURE FLAG
#
# USE_REAL_CALLER_DB = False  →  MockCallerRepository (active, zero I/O)
# USE_REAL_CALLER_DB = True   →  CallerProfileClient  (disabled, falls back)
#
# Flip to True ONLY after:
#   1. Backend /v1/callers/{phone} endpoint is implemented and tested
#   2. INTERNAL_API_URL and INTERNAL_API_KEY are set in AgentConfig
# ─────────────────────────────────────────────────────────────────────────────

USE_REAL_CALLER_DB: bool = False

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1 — Domain models
# ─────────────────────────────────────────────────────────────────────────────

ConfidenceLevel = Literal["high", "medium", "low", "unknown"]
CallerSource = Literal["mock", "database"]


class CallerMetadata(BaseModel):
    """
    Audit and monitoring metadata attached to every caller lookup.

    lookup_ms is measured on the actual code path (including mock)
    so it remains useful as a latency baseline when the real DB is wired.
    """

    source: CallerSource
    lookup_ms: float = Field(ge=0.0, description="Wall-clock lookup time in milliseconds")
    phone_e164: str = Field(description="Normalised E.164 phone — safe to pass to other tools")
    phone_log_safe: str = Field(description="Masked phone number safe for log output")


class GetCallerInfoData(BaseModel):
    """
    Full caller profile returned inside ToolResult.data["data"].

    The AI uses:
        - greeting_hint      → decides how to open the call
        - should_ask_for_name→ decides whether to ask "May I get your name?"
        - first_name         → personalises the greeting if known
        - past_purchases     → offers relevant product suggestions
        - preferred_language → signals if the agent should switch languages
    """

    found: bool
    is_new_caller: bool

    # Identity
    caller_name: Optional[str] = None          # Full name e.g. "Marcus Williams"
    first_name: Optional[str] = None           # First name only e.g. "Marcus"

    # History
    call_count: int = 0
    last_call_date: Optional[str] = None       # ISO-8601 date string "YYYY-MM-DD"
    past_purchases: list[str] = Field(default_factory=list)
                                               # ["A Thug's Heartbeat x1", ...]

    # Preferences
    preferred_language: str = "en"             # ISO 639-1

    # Confidence
    confidence: float = Field(ge=0.0, le=1.0)
    confidence_level: ConfidenceLevel
    confidence_reason: str

    # Agent guidance (read-only hints for the LLM)
    should_ask_for_name: bool
    greeting_hint: str

    # Audit
    metadata: CallerMetadata


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 2 — Request model
# ─────────────────────────────────────────────────────────────────────────────


class GetCallerInfoRequest(BaseModel):
    """
    Accepted phone formats:
        "+15551234567"   — E.164 (preferred)
        "5551234567"     — 10-digit US (normalised to +1...)
        "+1 (555) 123-4567" — formatted (stripped to digits, then normalised)
    """

    phone_number: str = Field(
        ...,
        description="Caller phone number — E.164 preferred, raw digits accepted",
    )

    @field_validator("phone_number")
    @classmethod
    def normalise_and_validate(cls, v: str) -> str:
        normalised = normalize_phone(v.strip())
        if not normalised or len(normalised) < 8:
            raise ValueError(
                f"Cannot normalise phone number from {v!r}. "
                "Provide E.164 format or a 10-digit US number."
            )
        return normalised


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 3 — Pure helpers (zero I/O, fully unit-testable)
# ─────────────────────────────────────────────────────────────────────────────


def _confidence_level(score: float) -> ConfidenceLevel:
    """Map a numeric confidence score to a human-readable level."""
    if score >= 0.90:
        return "high"
    if score >= 0.60:
        return "medium"
    if score >= 0.30:
        return "low"
    return "unknown"


def _should_ask_for_name(
    is_new_caller: bool,
    caller_name: Optional[str],
    confidence: float,
) -> bool:
    """
    True  → AI should ask the caller for their name.
    False → AI can use the stored name (or skip the question entirely).

    Rules:
    - New caller → always ask
    - No stored name → always ask
    - Known name, high confidence (≥ 0.90) → skip (use stored name)
    - Known name, medium confidence (0.60–0.89) → AI will ask "Is this [name]?"
      so we still set True (name needs verbal confirmation)
    """
    if is_new_caller or caller_name is None:
        return True
    return confidence < 0.90


def _build_greeting_hint(
    is_new_caller: bool,
    first_name: Optional[str],
    confidence: float,
    confidence_level: ConfidenceLevel,
) -> str:
    """
    Return a one-sentence instruction the AI uses to open the call.
    Kept brief so it adds minimal tokens to the context window.
    """
    if is_new_caller:
        return "New caller — greet warmly and ask for their name after your opening."

    if first_name and confidence_level == "high":
        return f"Returning caller. Safe to address as {first_name}."

    if first_name and confidence_level == "medium":
        return (
            f"Likely returning caller. Ask 'Is this {first_name}?' "
            "to confirm before using their name."
        )

    if first_name and confidence_level == "low":
        return (
            "Probable returning caller but match is uncertain. "
            "Greet generically and ask for their name."
        )

    # No name on record
    return "Returning caller — name unknown. Greet generically and ask for their name."


def _mask_phone(phone: str) -> str:
    """
    Produce a log-safe phone representation.
    '+15551234567' → '+15***67'
    Prevents full phone numbers from appearing in log files.
    """
    if len(phone) <= 6:
        return phone[:2] + "***"
    return f"{phone[:3]}***{phone[-2:]}"


def _extract_first_name(full_name: Optional[str]) -> Optional[str]:
    """'Marcus Williams' → 'Marcus'.  None → None."""
    if not full_name:
        return None
    return full_name.strip().split()[0]


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4 — MOCK LAYER  (primary path, USE_REAL_CALLER_DB = False)
#
# All data is static — no I/O, no randomness, deterministic by phone digit.
# Lookup is synchronous; elapsed time is measured to give a real baseline.
#
# Scenarios (last digit of normalised E.164):
#   0–2  → High confidence returning customer (name known, call history)
#   3–5  → Medium confidence returning customer (name known, fewer calls)
#   6–7  → Low confidence returning caller (name unknown)
#   8–9  → New caller (no record)
#
# DO NOT DELETE — this is the safe fallback for all environments.
# ─────────────────────────────────────────────────────────────────────────────

# Pre-built scenario payloads — module-level to avoid repeated construction

_SCENARIO_HIGH = dict(
    found=True,
    is_new_caller=False,
    caller_name="Marcus Williams",
    call_count=7,
    last_call_date="2026-06-12",
    past_purchases=["A Thug's Heartbeat x1", "Tears of a Hustler x2"],
    preferred_language="en",
    confidence=0.97,
    confidence_reason="Exact phone match in caller profile database.",
)

_SCENARIO_MEDIUM = dict(
    found=True,
    is_new_caller=False,
    caller_name="Keisha Johnson",
    call_count=2,
    last_call_date="2026-05-28",
    past_purchases=["Hood Rich x1"],
    preferred_language="en",
    confidence=0.82,
    confidence_reason="Phone matched but name has not been verbally reconfirmed.",
)

_SCENARIO_LOW = dict(
    found=True,
    is_new_caller=False,
    caller_name=None,
    call_count=1,
    last_call_date="2026-06-01",
    past_purchases=[],
    preferred_language="en",
    confidence=0.61,
    confidence_reason="Phone number seen before but caller declined to give name.",
)

_SCENARIO_NEW = dict(
    found=False,
    is_new_caller=True,
    caller_name=None,
    call_count=0,
    last_call_date=None,
    past_purchases=[],
    preferred_language="en",
    confidence=0.0,
    confidence_reason="No record found for this phone number.",
)

_SCENARIO_MAP: dict[str, dict] = {
    "0": _SCENARIO_HIGH,
    "1": _SCENARIO_HIGH,
    "2": _SCENARIO_HIGH,
    "3": _SCENARIO_MEDIUM,
    "4": _SCENARIO_MEDIUM,
    "5": _SCENARIO_MEDIUM,
    "6": _SCENARIO_LOW,
    "7": _SCENARIO_LOW,
    "8": _SCENARIO_NEW,
    "9": _SCENARIO_NEW,
}


class MockCallerRepository:
    """
    In-memory caller profile store for safe architecture phase.

    Lookup is synchronous and deterministic — last digit of the
    E.164 phone number selects the scenario.
    Replace with CallerProfileClient when the backend endpoint is ready.
    """

    @staticmethod
    def get(phone_e164: str) -> tuple[dict, float]:
        """
        Returns (scenario_dict, elapsed_ms).
        elapsed_ms is real wall-clock time — useful as a mock latency baseline.
        """
        t0 = time.perf_counter()

        last_digit = phone_e164[-1] if phone_e164[-1:].isdigit() else "9"
        scenario = _SCENARIO_MAP.get(last_digit, _SCENARIO_NEW)

        elapsed_ms = (time.perf_counter() - t0) * 1000
        return scenario, elapsed_ms


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 5 — REAL CLIENT PLACEHOLDER  (disabled — interface contract only)
#
# READ-ONLY by design — this client must NEVER mutate caller data.
# Mutation (save name, update preferences) belongs to save_caller_name tool.
#
# When USE_REAL_CALLER_DB = True and backend URL is configured,
# _resolve_caller_info() will call this. Currently raises NotImplementedError.
#
# Activation steps:
#   1. Set USE_REAL_CALLER_DB = True
#   2. Implement CallerProfileClient.get() with an httpx GET request
#   3. Set AgentConfig.internal_api_url and AgentConfig.internal_api_key
#   4. Map response via _map_api_response()
# ─────────────────────────────────────────────────────────────────────────────


class CallerProfileClient:
    """
    Interface contract for the real backend caller profile API.

    NOT YET IMPLEMENTED.
    Raises NotImplementedError → _resolve_caller_info() falls back to mock.

    Expected endpoint:
        GET {internal_api_url}/v1/callers/{phone_e164}
        Headers: x-api-key: {internal_api_key}

    Expected response shape:
        {
            "found": bool,
            "name": str | null,
            "call_count": int,
            "last_call_date": str | null,
            "past_purchases": [str],
            "preferred_language": str,
            "confidence": float
        }
    """

    def __init__(self, api_url: str, api_key: str) -> None:
        self._api_url = api_url.rstrip("/")
        self._api_key = api_key

    async def get(self, phone_e164: str) -> tuple[dict, float]:
        # TODO: implement when backend API is ready
        #
        #   import httpx
        #   t0 = time.perf_counter()
        #   async with httpx.AsyncClient(timeout=3.0) as client:
        #       r = await client.get(
        #           f"{self._api_url}/v1/callers/{phone_e164}",
        #           headers={"x-api-key": self._api_key},
        #       )
        #   elapsed_ms = (time.perf_counter() - t0) * 1000
        #   r.raise_for_status()
        #   return r.json(), elapsed_ms
        raise NotImplementedError(
            "CallerProfileClient.get() is not yet implemented. "
            "Keep USE_REAL_CALLER_DB=False until the backend endpoint exists."
        )


def _map_api_response(raw: dict) -> dict:
    """
    Normalise a raw backend API response to the internal scenario dict shape.

    NOT YET ACTIVE — called only by CallerProfileClient.get() path.
    Kept here so the mapping contract is visible during architecture review.
    """
    return {
        "found": raw.get("found", False),
        "is_new_caller": not raw.get("found", False),
        "caller_name": raw.get("name"),
        "call_count": raw.get("call_count", 0),
        "last_call_date": raw.get("last_call_date"),
        "past_purchases": raw.get("past_purchases", []),
        "preferred_language": raw.get("preferred_language", "en"),
        "confidence": float(raw.get("confidence", 0.0)),
        "confidence_reason": raw.get("confidence_reason", "Returned by backend API."),
    }


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 6 — Resolver
# ─────────────────────────────────────────────────────────────────────────────


async def _resolve_caller_info(
    phone_e164: str,
    internal_api_url: str,
    internal_api_key: str,
) -> tuple[dict, float]:
    """
    Route to mock or real backend based on USE_REAL_CALLER_DB flag.

    Fallback chain when USE_REAL_CALLER_DB = True:
        CallerProfileClient.get()
            ↓ NotImplementedError  → MockCallerRepository.get() + warning
            ↓ any exception        → MockCallerRepository.get() + error log
    """
    use_real = USE_REAL_CALLER_DB and bool(internal_api_url and internal_api_key)

    if use_real:
        try:
            client = CallerProfileClient(internal_api_url, internal_api_key)
            raw, elapsed_ms = await client.get(phone_e164)
            return _map_api_response(raw), elapsed_ms
        except NotImplementedError:
            logger.warning(
                "CallerProfileClient not implemented — falling back to mock"
            )
        except Exception as exc:
            logger.error(
                "CallerProfileClient.get(%s) failed: %s — falling back to mock",
                _mask_phone(phone_e164),
                exc,
                exc_info=True,
            )

    logger.debug("get_caller_info: using MockCallerRepository")
    return MockCallerRepository.get(phone_e164)


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 7 — Data assembler (pure, builds GetCallerInfoData from raw scenario)
# ─────────────────────────────────────────────────────────────────────────────


def _assemble(
    scenario: dict,
    elapsed_ms: float,
    phone_e164: str,
    source: CallerSource,
) -> GetCallerInfoData:
    """
    Convert a raw scenario dict into a fully-typed GetCallerInfoData.
    All derived fields (confidence_level, should_ask_for_name, greeting_hint)
    are computed here via pure functions so they stay testable in isolation.
    """
    caller_name: Optional[str] = scenario.get("caller_name")
    first_name = _extract_first_name(caller_name)
    confidence: float = scenario.get("confidence", 0.0)
    is_new_caller: bool = scenario.get("is_new_caller", True)

    level = _confidence_level(confidence)
    ask_name = _should_ask_for_name(is_new_caller, caller_name, confidence)
    hint = _build_greeting_hint(is_new_caller, first_name, confidence, level)

    return GetCallerInfoData(
        found=scenario.get("found", False),
        is_new_caller=is_new_caller,
        caller_name=caller_name,
        first_name=first_name,
        call_count=scenario.get("call_count", 0),
        last_call_date=scenario.get("last_call_date"),
        past_purchases=scenario.get("past_purchases", []),
        preferred_language=scenario.get("preferred_language", "en"),
        confidence=confidence,
        confidence_level=level,
        confidence_reason=scenario.get("confidence_reason", ""),
        should_ask_for_name=ask_name,
        greeting_hint=hint,
        metadata=CallerMetadata(
            source=source,
            lookup_ms=round(elapsed_ms, 3),
            phone_e164=phone_e164,
            phone_log_safe=_mask_phone(phone_e164),
        ),
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 8 — Tool class
# ─────────────────────────────────────────────────────────────────────────────


class GetCallerInfoTool(BaseTool):
    name = "get_caller_info"
    description = (
        "Look up a caller's profile by phone number before starting the conversation. "
        "Returns caller identity, history, confidence level, and a greeting hint. "
        "Call this at the start of a call to personalise the opening and decide "
        "whether to ask for the caller's name. READ-ONLY — does not modify any data."
    )
    parameters = {
        "type": "object",
        "properties": {
            "phone_number": {
                "type": "string",
                "description": (
                    "Caller phone number. E.164 preferred (e.g. '+15551234567'). "
                    "10-digit US numbers also accepted."
                ),
            },
        },
        "required": ["phone_number"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        # ── Validate + normalise phone ────────────────────────────────────────
        try:
            req = GetCallerInfoRequest(**args)
        except Exception as exc:
            logger.warning(
                "get_caller_info: invalid phone input %r (session=%s): %s",
                args.get("phone_number"),
                context.session_id,
                exc,
            )
            return self.error_result(
                voice_summary="",
                error=f"Invalid phone number: {exc}",
                message="get_caller_info received an unrecognisable phone number",
            )

        phone_e164 = req.phone_number

        # ── Resolve caller profile ────────────────────────────────────────────
        try:
            scenario, elapsed_ms = await _resolve_caller_info(
                phone_e164=phone_e164,
                internal_api_url=context.agent_config.internal_api_url,
                internal_api_key=context.agent_config.internal_api_key,
            )
        except Exception as exc:
            logger.error(
                "get_caller_info: resolver error (session=%s): %s",
                context.session_id,
                exc,
                exc_info=True,
            )
            return self.error_result(
                voice_summary="",
                error=f"Caller lookup failed: {exc}",
            )

        # ── Assemble typed result ─────────────────────────────────────────────
        source: CallerSource = (
            "database"
            if (USE_REAL_CALLER_DB and scenario.get("confidence_reason", "").find("backend") >= 0)
            else "mock"
        )
        data = _assemble(scenario, elapsed_ms, phone_e164, source)

        # ── Structured log ────────────────────────────────────────────────────
        logger.info(
            "get_caller_info: phone=%s found=%s confidence=%s(%s) "
            "name=%r ask_name=%s source=%s lookup_ms=%.3f session=%s",
            _mask_phone(phone_e164),
            data.found,
            data.confidence,
            data.confidence_level,
            data.caller_name,
            data.should_ask_for_name,
            data.metadata.source,
            data.metadata.lookup_ms,
            context.session_id,
        )

        # ── Build message ─────────────────────────────────────────────────────
        if data.is_new_caller:
            message = "New caller — no profile found."
        else:
            message = (
                f"Caller profile found ({data.confidence_level} confidence)."
            )

        # ── State update (read-only values only) ──────────────────────────────
        # Only propagate fields that the pipeline already tracks.
        # This does NOT write to any external store — it patches in-memory state.
        state_update: dict[str, Any] = {}
        if data.first_name and not context.session_state.caller_name:
            state_update["caller_name"] = data.first_name
        if data.preferred_language:
            state_update["language"] = data.preferred_language

        return ToolResult(
            success=True,
            data={
                "success": True,
                "message": message,
                "data": data.model_dump(),
                "error": None,
            },
            voice_summary="",   # data tool — AI constructs the greeting using greeting_hint
            state_update=state_update if state_update else None,
        )


# ── Self-register ─────────────────────────────────────────────────────────────

registry.register(GetCallerInfoTool())
