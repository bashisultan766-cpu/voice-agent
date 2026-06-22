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
