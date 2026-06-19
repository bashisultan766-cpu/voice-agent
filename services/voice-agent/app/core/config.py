"""
Canonical settings for the voice-agent service.

All secrets and runtime configuration come from environment variables or .env.
Load order: environment → .env file → field defaults.

app/config.py re-exports from here for backward compatibility with existing imports.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):

    # ── Server ────────────────────────────────────────────────────────────────
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    DEBUG: bool = False
    LOG_LEVEL: str = "INFO"
    # Public HTTPS URL. Twilio webhooks and audio URLs are built from this.
    # Must be https:// in production (Media Streams WebSocket requires wss://).
    BASE_URL: str = "http://localhost:8000"

    # ── Twilio ────────────────────────────────────────────────────────────────
    TWILIO_ACCOUNT_SID: str = ""
    TWILIO_AUTH_TOKEN: str = ""
    TWILIO_PHONE_NUMBER: str = ""
    # Must be True in production — validates every incoming webhook signature.
    TWILIO_VALIDATE_REQUESTS: bool = True

    # ── LLM (OpenAI) ──────────────────────────────────────────────────────────
    OPENAI_API_KEY: str = ""
    # Default model: cheap and fast for most turns.
    LLM_MODEL: str = "gpt-4o-mini"
    # Escalation model: used only when a complex multi-tool chain is detected.
    LLM_ESCALATION_MODEL: str = "gpt-4o"
    # Conversation turns kept in the LLM context (each turn = 2 messages).
    LLM_HISTORY_WINDOW: int = 10
    # Max tokens the LLM may generate per turn.
    LLM_MAX_TOKENS_PER_TURN: int = 400
    # Legacy alias — identical default; use LLM_MODEL going forward.
    OPENAI_MODEL: str = "gpt-4o-mini"

    # ── STT ───────────────────────────────────────────────────────────────────
    STT_PROVIDER: Literal["deepgram", "openai"] = "deepgram"
    # Required when STT_PROVIDER=deepgram.
    DEEPGRAM_API_KEY: str = ""

    # ── TTS ───────────────────────────────────────────────────────────────────
    TTS_PROVIDER: Literal["openai", "elevenlabs"] = "openai"
    # OpenAI TTS — active when TTS_PROVIDER=openai.
    OPENAI_TTS_MODEL: str = "tts-1"
    OPENAI_TTS_VOICE: str = "nova"     # alloy | echo | fable | onyx | nova | shimmer
    OPENAI_TTS_SPEED: float = 1.0
    # ElevenLabs — active when TTS_PROVIDER=elevenlabs.
    ELEVENLABS_API_KEY: str = ""
    ELEVENLABS_VOICE_ID: str = ""

    # ── Shopify ───────────────────────────────────────────────────────────────
    # True = use mock data (safe build phase). False = real Shopify Admin API.
    SHOPIFY_USE_MOCK: bool = True
    SHOPIFY_DOMAIN: Optional[str] = None        # e.g. "your-store.myshopify.com"
    SHOPIFY_ACCESS_TOKEN: Optional[str] = None

    # ── Agent backend API (all 13 tool endpoints) ─────────────────────────────
    # The NestJS API that backs order lookup, catalog search, etc.
    # Tools call e.g. {AGENT_API_BASE}/v1/orders/{number}
    AGENT_API_BASE: str = ""
    AGENT_API_KEY: str = ""

    # ── Email (Resend) ────────────────────────────────────────────────────────
    RESEND_API_KEY: Optional[str] = None
    RESEND_FROM_EMAIL: str = "orders@example.com"

    # ── Cost control & safety cutoffs ─────────────────────────────────────────
    # Disconnect the call after this many seconds (hard cap).
    MAX_CALL_DURATION_S: int = 300
    # Total token budget across all LLM turns in one call.
    MAX_TOKENS_PER_CALL: int = 8000
    # Emit a structured cost/token log line at end of each call.
    COST_LOG_ENABLED: bool = True

    # ── Session / single-tenant defaults (Phase 1) ────────────────────────────
    # SINGLE_TENANT: DEFAULT_TENANT_ID / DEFAULT_AGENT_ID / tenant loader are
    # removable for single-client deployments — kept for backward compat only.
    DEFAULT_AGENT_ID: str = "default"
    DEFAULT_TENANT_ID: str = "default"
    DEFAULT_AGENT_NAME: str = "Alex"
    DEFAULT_BUSINESS_NAME: str = "My Store"
    # Voice precedence: AgentConfig.voice_id (per-tenant) → OPENAI_TTS_VOICE (global default).

    # ── Internal / v2 tool settings ───────────────────────────────────────────
    # Customer service escalation email (escalate_to_customer_service tool).
    CS_EMAIL: str = ""

    # ── Audio ─────────────────────────────────────────────────────────────────
    # Local directory for pre-synthesized TTS MP3 files (served as static files).
    AUDIO_CACHE_DIR: str = "./audio_cache"

    # ── Redis (optional) ──────────────────────────────────────────────────────
    # Leave blank to use the in-memory session store.
    # Set a Redis URL for multi-instance / persistent sessions.
    REDIS_URL: Optional[str] = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── Convenience helpers ───────────────────────────────────────────────────

    @property
    def effective_llm_model(self) -> str:
        """LLM_MODEL wins over the legacy OPENAI_MODEL alias."""
        return self.LLM_MODEL or self.OPENAI_MODEL

    @property
    def deepgram_configured(self) -> bool:
        return bool(self.DEEPGRAM_API_KEY)

    @property
    def elevenlabs_configured(self) -> bool:
        return bool(self.ELEVENLABS_API_KEY and self.ELEVENLABS_VOICE_ID)

    @property
    def shopify_configured(self) -> bool:
        return bool(self.SHOPIFY_DOMAIN and self.SHOPIFY_ACCESS_TOKEN)

    @property
    def agent_api_configured(self) -> bool:
        return bool(self.AGENT_API_BASE)


@lru_cache
def get_settings() -> Settings:
    return Settings()
