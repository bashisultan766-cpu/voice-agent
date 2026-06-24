"""Tests for OpenAI health / usage proof (v4.17). No network calls."""
import asyncio
from dataclasses import dataclass

import pytest

from app.agent_runtime import openai_health


@dataclass
class _FakeSettings:
    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o-mini"


class _FakeUsage:
    prompt_tokens = 12
    completion_tokens = 7
    total_tokens = 19


class _FakeResponse:
    usage = _FakeUsage()


def test_openai_runtime_configured():
    """When a key is present, health reports configured + env source + model."""
    settings = _FakeSettings(OPENAI_API_KEY="sk-not-a-real-key", OPENAI_MODEL="gpt-4o-mini")
    health = openai_health.get_health(settings)
    assert health.configured is True
    assert health.key_source == "env"
    assert health.model == "gpt-4o-mini"
    # Log field string must never contain the key value.
    assert "sk-not-a-real-key" not in health.as_log_fields()


def test_openai_missing_key_reports_missing():
    settings = _FakeSettings(OPENAI_API_KEY="")
    health = openai_health.get_health(settings)
    assert health.configured is False
    assert health.key_source == "missing"


def test_key_source_precedence():
    settings = _FakeSettings(OPENAI_API_KEY="env-key")
    assert openai_health.detect_key_source(settings, agent_key="ak") == "agent"
    assert openai_health.detect_key_source(settings, tenant_key="tk") == "tenant"
    assert openai_health.detect_key_source(settings) == "env"
    assert openai_health.detect_key_source(_FakeSettings()) == "missing"


def test_usage_extraction_logs_tokens():
    usage = openai_health.log_response_completed(
        "CA123456", "gpt-4o-mini", response=_FakeResponse(), purpose="brain"
    )
    assert usage["prompt_tokens"] == 12
    assert usage["completion_tokens"] == 7
    assert usage["total_tokens"] == 19


def test_run_check_missing_key_fails_loudly():
    settings = _FakeSettings(OPENAI_API_KEY="")
    result = asyncio.run(openai_health.run_openai_check(settings))
    assert result["ok"] is False
    assert result["key_present"] is False
    assert result["error_code"] == "missing_api_key"


def test_check_cli_importable():
    from app.scripts import check_openai_runtime

    assert callable(check_openai_runtime.main)
