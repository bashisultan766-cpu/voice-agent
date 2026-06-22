from __future__ import annotations

from functools import lru_cache
from urllib.parse import urlparse

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── Runtime ───────────────────────────────────────────────────────────────
    VOICE_RUNTIME: str = "twilio_conversation_relay"
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    DEBUG: bool = False
    LOG_LEVEL: str = "info"

    # Public HTTPS base URL — must be https:// in production.
    # ConversationRelay WebSocket URL is derived from this.
    PUBLIC_BASE_URL: str = "https://example.com"

    # ── Twilio ────────────────────────────────────────────────────────────────
    TWILIO_ACCOUNT_SID: str = ""
    TWILIO_AUTH_TOKEN: str = ""
    TWILIO_PHONE_NUMBER: str = ""
    VALIDATE_TWILIO_SIGNATURES: bool = True

    # ── OpenAI ────────────────────────────────────────────────────────────────
    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o-mini"
    OPENAI_TIMEOUT_SECS: float = 30.0

    # ── Shopify ───────────────────────────────────────────────────────────────
    SHOPIFY_SHOP_DOMAIN: str = ""
    SHOPIFY_ADMIN_ACCESS_TOKEN: str = ""
    SHOPIFY_API_VERSION: str = "2026-01"
    SHOPIFY_TIMEOUT_SECS: float = 10.0
    SHOPIFY_CACHE_TTL_SECS: int = 60

    # ── Redis ─────────────────────────────────────────────────────────────────
    REDIS_URL: str = "redis://127.0.0.1:6379"

    # ── Database (optional call log integration) ──────────────────────────────
    DATABASE_URL: str = ""

    # ── Resend (email for payment links) ──────────────────────────────────────
    RESEND_API_KEY: str = ""
    RESEND_FROM_EMAIL: str = "noreply@example.com"
    RESEND_FROM_NAME: str = "Bookstore Support"
    RESEND_REPLY_TO_EMAIL: str = ""
    RESEND_BRAND_NAME: str = "SureShot Books"
    SUPPORT_EMAIL: str = ""              # Optional reply-to / escalation email

    # ── Pipeline speed budgets ────────────────────────────────────────────────
    # How long the first prompt waits for the caller profile to load (ms).
    VOICE_FIRST_PROMPT_PROFILE_TIMEOUT_MS: int = 750
    # Per-tool timeout for speculative prefetch and live tool calls (ms).
    VOICE_TOOL_TIMEOUT_MS: int = 2500
    # Shopify GraphQL per-request hard timeout (ms).
    VOICE_SHOPIFY_TIMEOUT_MS: int = 2500
    # OpenAI streaming call timeout (ms).
    VOICE_OPENAI_TIMEOUT_MS: int = 8000
    # Emit a filler phrase only if tools have not responded after this many ms.
    VOICE_FILLER_AFTER_MS: int = 250
    # Soft limit on LLM reply length in words (for compact context prompt).
    VOICE_MAX_REPLY_WORDS: int = 50

    # ── Webhooks / admin ──────────────────────────────────────────────────────
    # Shopify webhook HMAC secret (configure when registering webhooks).
    SHOPIFY_WEBHOOK_SECRET: str = ""
    # Bearer key for the /admin/sync endpoint — keep server-side only.
    INTERNAL_ADMIN_KEY: str = ""

    # ── v4.2: Live voice OpenAI tool-calling guard ────────────────────────────
    # When true (default), ALL intents are routed through the worker→composer
    # path. OpenAI never receives tool schemas; session.history never stores
    # role="tool" or assistant tool_calls. Eliminates 400 errors on interrupt.
    VOICE_LIVE_DISABLE_OPENAI_TOOLS: bool = True

    # ── v4.8: Business rules ──────────────────────────────────────────────────
    # Jessica's email for address updates
    JESSICA_EMAIL: str = ""
    CUSTOMER_SERVICE_EMAIL: str = ""

    # Shipping policy
    SHIPPING_DEFAULT_METHOD: str = "Media Mail"
    SHIPPING_ALT_METHOD: str = "Priority Mail"
    SHIPPING_CALCULATION_MODE: str = "shopify_or_policy"
    SHIPPING_MEDIA_MAIL_PRICE: str = ""
    SHIPPING_PRIORITY_MAIL_PRICE: str = ""
    SHIPPING_REQUIRE_DESTINATION: bool = True

    # Call resume/cutoff window
    CALL_RESUME_WINDOW_MINUTES: int = 30

    # Turn-taking silence thresholds (ms)
    VOICE_MIN_FINAL_SILENCE_MS: int = 1200
    VOICE_DIGIT_COLLECTION_SILENCE_MS: int = 2500
    VOICE_EMAIL_COLLECTION_SILENCE_MS: int = 2500
    VOICE_ORDER_COLLECTION_SILENCE_MS: int = 2500
    VOICE_ALLOW_BARGE_IN: bool = True
    VOICE_INTERRUPT_GRACE_MS: int = 500

    # ── v4.6: ElevenLabs voice via Twilio ConversationRelay ───────────────────
    VOICE_TTS_PROVIDER: str = "ElevenLabs"
    VOICE_ID: str = ""
    VOICE_MODEL: str = "flash_v2_5"
    VOICE_SPEED: float = 1.0
    VOICE_STABILITY: float = 0.55
    VOICE_SIMILARITY: float = 0.80
    VOICE_LANGUAGE: str = "en-US"
    # Optional — not used in live Twilio path yet; do not log.
    ELEVENLABS_API_KEY: str = ""

    # ── Legacy flags — both must be false for ConversationRelay runtime ───────
    ENABLE_ELEVENLABS: bool = False
    ENABLE_DEEPGRAM: bool = False

    # ── Derived helpers ───────────────────────────────────────────────────────

    @property
    def ws_url(self) -> str:
        """wss:// URL for Twilio ConversationRelay."""
        base = self.PUBLIC_BASE_URL.rstrip("/")
        ws_base = base.replace("https://", "wss://").replace("http://", "ws://")
        return f"{ws_base}/voice/twilio/ws"

    @property
    def public_host(self) -> str:
        return urlparse(self.PUBLIC_BASE_URL).netloc

    @property
    def shopify_configured(self) -> bool:
        return bool(self.SHOPIFY_SHOP_DOMAIN and self.SHOPIFY_ADMIN_ACCESS_TOKEN)

    def build_conversation_relay_voice(self) -> str:
        """
        Voice string for Twilio ConversationRelay.

        ElevenLabs: {VOICE_ID}-{VOICE_MODEL} or Google fallback when not configured.
        """
        if self.VOICE_TTS_PROVIDER.lower() == "elevenlabs" and self.VOICE_ID:
            return f"{self.VOICE_ID}-{self.VOICE_MODEL}"
        return "Google.en-US-Neural2-J"

    def validate_production(self) -> None:
        """Fail fast on missing required secrets when not in DEBUG mode."""
        if self.DEBUG:
            return
        missing = [
            name
            for name, val in [
                ("OPENAI_API_KEY", self.OPENAI_API_KEY),
                ("TWILIO_ACCOUNT_SID", self.TWILIO_ACCOUNT_SID),
                ("TWILIO_AUTH_TOKEN", self.TWILIO_AUTH_TOKEN),
            ]
            if not val
        ]
        if missing:
            raise RuntimeError(f"Missing required env vars: {', '.join(missing)}")

        if self.ENABLE_ELEVENLABS or self.ENABLE_DEEPGRAM:
            raise RuntimeError(
                "ENABLE_ELEVENLABS and ENABLE_DEEPGRAM must be false for the "
                "twilio_conversation_relay runtime."
            )


@lru_cache
def get_settings() -> Settings:
    return Settings()
