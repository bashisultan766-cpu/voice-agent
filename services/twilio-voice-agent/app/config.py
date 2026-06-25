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
    # Primary model for every caller turn — must be capable enough to own final speech.
    OPENAI_MODEL: str = "gpt-4o"
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
    VOICE_TOOL_PROGRESS_AFTER_MS: int = 400
    # Soft limit on LLM reply length in words (for compact context prompt).
    VOICE_MAX_REPLY_WORDS: int = 50

    # ── Webhooks / admin ──────────────────────────────────────────────────────
    # Shopify webhook HMAC secret (configure when registering webhooks).
    SHOPIFY_WEBHOOK_SECRET: str = ""
    # Bearer key for the /admin/sync endpoint — keep server-side only.
    INTERNAL_ADMIN_KEY: str = ""

    # ── v4.2: Legacy OpenAI agent tool-calling guard ─────────────────────────
    # When true (default), blocks the OLD run_agent_turn streaming path and the
    # RealtimePipelineEngine worker→composer fallback from using OpenAI tools.
    # Does NOT affect llm_tool_runtime, which is the sole live runtime and
    # always uses OpenAI function-calling via app/agent_runtime/llm_tools.py.
    VOICE_LIVE_DISABLE_OPENAI_TOOLS: bool = True

    # ── v4.8: Business rules ──────────────────────────────────────────────────
    # Jessica's email for address updates
    JESSICA_EMAIL: str = ""
    CUSTOMER_SERVICE_EMAIL: str = ""

    # ── v4.18: LLM-first tool runtime (single active runtime) ─────────────────
    # The only supported live runtime. Legacy modes (main_llm_agent,
    # eric_agent_runtime, legacy_v410, llm_first) are quarantined and never run
    # in the customer path — dispatch always routes to llm_tool_runtime.
    VOICE_AGENT_RUNTIME_MODE: str = "llm_tool_runtime"
    # Approximate token budget for the system prompt; above this the master
    # prompt is sent section-by-section (safety sections always included).
    VOICE_PROMPT_TOKEN_BUDGET: int = 4000
    # When true (default), every spoken reply is composed by OPENAI_MODEL from the
    # master system prompt. Deterministic short-circuits may update session state
    # but never bypass the model for customer-facing text.
    VOICE_LLM_ONLY_FINAL_OUTPUT: bool = True
    # When false (default with llm-only), do not override the model's final text
    # with canned commerce/payment templates after tool calls.
    VOICE_ENFORCE_DETERMINISTIC_TOOL_RESPONSE: bool = False
    VOICE_SUPERVISOR_MODEL: str = "gpt-4o"
    VOICE_FINAL_MODEL: str = "gpt-4o"
    VOICE_MAIN_LLM_TIMEOUT_MS: int = 6000
    VOICE_SUPERVISOR_TIMEOUT_MS: int = 1800
    VOICE_FINAL_TIMEOUT_MS: int = 2500
    VOICE_WORKER_FANOUT_TIMEOUT_MS: int = 2500
    VOICE_MEMORY_TURNS: int = 50

    # ── v4.11.1: ConversationRelay outbound text delivery ─────────────────────
    VOICE_LOG_OUTBOUND_TEXT: bool = True
    VOICE_OUTBOUND_TEXT_MAX_LOG_CHARS: int = 160
    VOICE_CR_TEXT_INTERRUPTIBLE: bool = True
    VOICE_CR_TEXT_PREEMPTIBLE: bool = False

    # ── v4.12: Welcome greeting + LLM-first final speaker ─────────────────────
    VOICE_WELCOME_GREETING_ENABLED: bool = True
    VOICE_WELCOME_GREETING: str = (
        "Hello! Thank you for calling SureShot Books. How can I help you today?"
    )
    VOICE_WELCOME_GREETING_INTERRUPTIBLE: str = "any"
    VOICE_FINAL_RESPONSE_MODE: str = "llm_first"  # llm_first | deterministic_legacy
    VOICE_FINAL_LLM_FOR_SMALL_TALK: bool = True
    VOICE_FINAL_LLM_FOR_UNKNOWN: bool = True
    VOICE_FINAL_LLM_FOR_OUT_OF_DOMAIN: bool = True
    VOICE_FINAL_LLM_FOR_CLARIFICATION: bool = True

    # ── v4.13: Eric prompt file + conversation state machine ──────────────────
    ERIC_SYSTEM_PROMPT_PATH: str = "app/data/eric_system_prompt.md"
    ERIC_SYSTEM_PROMPT_VERSION: str = "v1"

    # ── v4.15.1: Eric prompt pack (multi-file system prompt) ──────────────────
    ERIC_PROMPT_PACK_DIR: str = "app/data/prompt_pack"
    ERIC_PROMPT_PACK_ENABLED: bool = True
    ERIC_PROMPT_PACK_REQUIRE_ALL: bool = True
    ERIC_PROMPT_MAX_CHARS: int = 60000
    VOICE_ISBN_PARTIAL_TIMEOUT_MS: int = 5000
    VOICE_COLLECTION_MAX_HOLD_MS: int = 7000
    VOICE_COLLECTION_KEEPALIVE_ENABLED: bool = True

    # ── v4.9: EricDialogueBrain ───────────────────────────────────────────────
    VOICE_LLM_BRAIN_ENABLED: bool = True
    VOICE_LLM_BRAIN_MODEL: str = "gpt-4o-mini"
    VOICE_LLM_BRAIN_TIMEOUT_MS: int = 1800
    VOICE_LLM_BRAIN_MAX_RETRIES: int = 1

    # Turn assembler debounce (ms) for normal speech
    VOICE_TURN_ASSEMBLER_DEBOUNCE_MS: int = 750

    # Shipping policy
    SHIPPING_DEFAULT_METHOD: str = "Media Mail"
    SHIPPING_ALT_METHOD: str = "Priority Mail"
    SHIPPING_CALCULATION_MODE: str = "shopify_or_policy"
    SHIPPING_MEDIA_MAIL_PRICE: str = ""
    SHIPPING_PRIORITY_MAIL_PRICE: str = ""
    SHIPPING_REQUIRE_DESTINATION: bool = True

    # Drop shipping fee (shown as "Drop Shipping Fee" on checkout + payment email)
    DROP_SHIPPING_FEE_ENABLED: bool = True
    DROP_SHIPPING_FEE_RATE: float = 0.03
    DROP_SHIPPING_FEE_MIN: float = 0.0

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

    # ── v4.14.6: Commerce demo hardening ─────────────────────────────────────
    VOICE_COMMERCE_DEMO_HARDENING: bool | None = None

    # ── v4.15.0: Payment certification + parallel catalog search ─────────────
    VOICE_PAYMENT_CERTIFICATION_MODE: bool = False
    VOICE_PAYMENT_CERTIFICATION_DRY_RUN: bool = True
    VOICE_PAYMENT_CERTIFICATION_ALLOW_REAL_EMAIL: bool = False
    VOICE_PAYMENT_CERTIFICATION_ALLOW_REAL_CHECKOUT: bool = False
    VOICE_PAYMENT_CERTIFICATION_TEST_EMAILS: str = ""
    VOICE_PAYMENT_CERTIFICATION_MAX_CART_LINES: int = 10
    VOICE_PAYMENT_IDEMPOTENCY_TTL_SECONDS: int = 1800
    VOICE_CATALOG_PARALLEL_SEARCH_LIMIT: int = 4
    VOICE_CATALOG_IDENTIFIER_TIMEOUT_MS: int = 5000

    # ── v4.16.0: Single Brain + Speculative Prefetch ─────────────────────────
    VOICE_BRAIN_ORCHESTRATOR_ENABLED: bool = True
    VOICE_SPECULATIVE_PREFETCH_ENABLED: bool = True
    VOICE_PREFETCH_MAX_WAIT_MS: int = 350
    VOICE_PREFETCH_SCOUT_TIMEOUT_MS: int = 1500
    VOICE_PREFETCH_CANCEL_ON_DIRECT_ANSWER: bool = True
    VOICE_BRAIN_MODEL: str = "gpt-4o-mini"
    VOICE_BRAIN_TIMEOUT_MS: int = 2500
    VOICE_BRAIN_DETERMINISTIC_GREETING_FASTPATH: bool = True
    VOICE_BRAIN_DOMAIN_BOUNDARY_STRICT: bool = True
    VOICE_BRAIN_PROMPT_CACHE_OPTIMIZED: bool = True

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
