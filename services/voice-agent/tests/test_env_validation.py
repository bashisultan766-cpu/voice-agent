"""Startup environment validation tests."""
from __future__ import annotations

import pytest

from app.core.config import Settings
from app.core.env_validation import validate_startup_env


def test_validate_startup_env_passes_with_https_and_secrets() -> None:
    settings = Settings(
        BASE_URL="https://voice.example.com",
        OPENAI_API_KEY="sk-test",
        DEEPGRAM_API_KEY="dg-test",
        TWILIO_AUTH_TOKEN="auth-test",
    )
    validate_startup_env(settings)


def test_validate_startup_env_rejects_http_base_url() -> None:
    settings = Settings(
        BASE_URL="http://localhost:8000",
        OPENAI_API_KEY="sk-test",
        DEEPGRAM_API_KEY="dg-test",
        TWILIO_AUTH_TOKEN="auth-test",
    )
    with pytest.raises(RuntimeError, match="BASE_URL must be https"):
        validate_startup_env(settings)


def test_validate_startup_env_rejects_missing_secrets() -> None:
    settings = Settings.model_construct(
        BASE_URL="https://voice.example.com",
        OPENAI_API_KEY="",
        DEEPGRAM_API_KEY="",
        TWILIO_AUTH_TOKEN="",
    )
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        validate_startup_env(settings)
