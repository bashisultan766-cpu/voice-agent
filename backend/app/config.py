from __future__ import annotations
import secrets
from typing import List
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # App
    APP_NAME: str = "Shopify Voice Agent API"
    API_VERSION: str = "v1"
    DEBUG: bool = False
    PORT: int = 8000

    # Database
    DATABASE_URL: str = "postgresql://postgres:postgres@localhost:5432/voice_agents"

    # Redis
    REDIS_URL: str = "redis://127.0.0.1:6379"

    # Security
    JWT_SECRET: str = Field(default_factory=lambda: secrets.token_hex(32))
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRES_SECS: int = 604800
    ENCRYPTION_KEY: str = "0" * 64  # 64 hex chars → 32 bytes AES-256

    # CORS
    CORS_ORIGINS: str = "http://localhost:3000,http://localhost:3001"

    @property
    def cors_origins_list(self) -> List[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    # Public URL (webhooks, audio hosting)
    PUBLIC_WEBHOOK_BASE_URL: str = "https://your-domain.com"

    # Twilio
    TWILIO_ACCOUNT_SID: str = ""
    TWILIO_AUTH_TOKEN: str = ""
    TWILIO_PHONE_NUMBER: str = ""
    VALIDATE_TWILIO_SIGNATURES: bool = True

    # OpenAI
    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o-mini"
    OPENAI_TTS_MODEL: str = "tts-1"
    OPENAI_TTS_VOICE: str = "alloy"
    MAX_TOOL_ITERATIONS: int = 8

    # Email
    RESEND_API_KEY: str = ""
    FROM_EMAIL: str = "noreply@example.com"

    # Shopify (global fallbacks; prefer per-agent credentials)
    SHOPIFY_ADMIN_API_TOKEN: str = ""
    SHOPIFY_STORE_URL: str = ""

    # Cache TTLs (seconds)
    SHOPIFY_CACHE_TTL: int = 60
    VOICE_RESPONSE_CACHE_TTL: int = 180

    @field_validator("ENCRYPTION_KEY")
    @classmethod
    def validate_encryption_key(cls, v: str) -> str:
        if len(v) != 64:
            raise ValueError("ENCRYPTION_KEY must be 64 hex characters (32 bytes)")
        return v


settings = Settings()
