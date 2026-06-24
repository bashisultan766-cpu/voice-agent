"""
OpenAI health + usage proof (v4.17).

Provides structured, secret-safe logging so the live logs prove the LLM is
actually used on each call, plus a reusable runtime check for the CLI.

Logged events (never include the API key, prompt text, or PII):
  openai_health   ... configured/key_source/model on startup and per call
  llm_request_started   sid/model/purpose
  llm_response_completed sid/model/prompt_tokens/completion_tokens/total_tokens/ms
  openai_error    sid/code (safe error code only)
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Module-level guard so startup health is logged once per process.
_startup_logged = False


@dataclass
class OpenAIHealth:
    configured: bool
    key_source: str  # agent | tenant | env | missing
    model: str

    def as_log_fields(self) -> str:
        return (
            f"openai_configured={'true' if self.configured else 'false'} "
            f"openai_key_source={self.key_source} model={self.model}"
        )


def detect_key_source(
    settings: Any = None,
    *,
    agent_key: str = "",
    tenant_key: str = "",
) -> str:
    """
    Resolve where the active OpenAI key comes from, without revealing it.

    Precedence: per-agent override > per-tenant override > .env/settings > none.
    """
    if agent_key:
        return "agent"
    if tenant_key:
        return "tenant"
    if settings is None:
        from ..config import get_settings

        settings = get_settings()
    # The settings object already loads OPENAI_API_KEY from .env; it is the
    # single source of truth (no os.environ fallback, to avoid ambiguity).
    key = getattr(settings, "OPENAI_API_KEY", "")
    return "env" if key else "missing"


def get_health(
    settings: Any = None,
    *,
    agent_key: str = "",
    tenant_key: str = "",
) -> OpenAIHealth:
    if settings is None:
        from ..config import get_settings

        settings = get_settings()
    source = detect_key_source(settings, agent_key=agent_key, tenant_key=tenant_key)
    return OpenAIHealth(
        configured=source != "missing",
        key_source=source,
        model=getattr(settings, "OPENAI_MODEL", "") or "unknown",
    )


def log_startup_health(settings: Any = None, *, force: bool = False) -> OpenAIHealth:
    """Log OpenAI health once at process startup (idempotent unless force)."""
    global _startup_logged
    health = get_health(settings)
    if not _startup_logged or force:
        logger.info("openai_health scope=startup %s", health.as_log_fields())
        if not health.configured:
            logger.error(
                "openai_health scope=startup openai_configured=false "
                "openai_key_source=missing — the LLM brain cannot answer."
            )
        _startup_logged = True
    return health


def log_call_health(sid: str, settings: Any = None) -> OpenAIHealth:
    """Log OpenAI health at the start of a call."""
    health = get_health(settings)
    logger.info("openai_health scope=call sid=%s %s", (sid or "")[:6], health.as_log_fields())
    return health


def log_request_started(sid: str, model: str, *, purpose: str = "brain") -> float:
    """Log that an LLM request started; returns a monotonic start time."""
    logger.info(
        "llm_request_started sid=%s model=%s purpose=%s",
        (sid or "")[:6],
        model,
        purpose,
    )
    return time.monotonic()


def _extract_usage(response: Any) -> dict[str, Optional[int]]:
    usage = getattr(response, "usage", None)
    if usage is None and isinstance(response, dict):
        usage = response.get("usage")
    if usage is None:
        return {"prompt_tokens": None, "completion_tokens": None, "total_tokens": None}

    def _get(name: str) -> Optional[int]:
        if isinstance(usage, dict):
            val = usage.get(name)
        else:
            val = getattr(usage, name, None)
        try:
            return int(val) if val is not None else None
        except (TypeError, ValueError):
            return None

    return {
        "prompt_tokens": _get("prompt_tokens"),
        "completion_tokens": _get("completion_tokens"),
        "total_tokens": _get("total_tokens"),
    }


def log_response_completed(
    sid: str,
    model: str,
    *,
    response: Any = None,
    started_at: Optional[float] = None,
    purpose: str = "brain",
) -> dict[str, Optional[int]]:
    """Log a successful LLM response with token usage if available."""
    usage = _extract_usage(response)
    ms = ""
    if started_at is not None:
        ms = f" ms={int((time.monotonic() - started_at) * 1000)}"
    logger.info(
        "llm_response_completed sid=%s model=%s purpose=%s "
        "prompt_tokens=%s completion_tokens=%s total_tokens=%s%s",
        (sid or "")[:6],
        model,
        purpose,
        usage["prompt_tokens"],
        usage["completion_tokens"],
        usage["total_tokens"],
        ms,
    )
    return usage


def _safe_error_code(error: BaseException) -> str:
    """Extract a safe, non-secret error code from an OpenAI/httpx exception."""
    for attr in ("status_code", "code"):
        val = getattr(error, attr, None)
        if val:
            return str(val)
    # Some SDK errors expose a `.response` with a status code.
    resp = getattr(error, "response", None)
    if resp is not None:
        code = getattr(resp, "status_code", None)
        if code:
            return str(code)
    return type(error).__name__


def log_error(sid: str, error: BaseException, *, purpose: str = "brain") -> str:
    """Log a safe OpenAI error code (never the message body, which may leak)."""
    code = _safe_error_code(error)
    logger.error(
        "openai_error sid=%s purpose=%s openai_error_code=%s",
        (sid or "")[:6],
        purpose,
        code,
    )
    return code


async def run_openai_check(
    settings: Any = None,
    *,
    timeout: float = 15.0,
) -> dict[str, Any]:
    """
    Verify OpenAI is reachable with a tiny completion. Never prints secrets.

    Returns a result dict:
      {ok, key_present, key_source, model, reachable, error_code, latency_ms}
    """
    if settings is None:
        from ..config import get_settings

        settings = get_settings()

    health = get_health(settings)
    result: dict[str, Any] = {
        "ok": False,
        "key_present": health.configured,
        "key_source": health.key_source,
        "model": health.model,
        "reachable": False,
        "error_code": None,
        "latency_ms": None,
    }

    if not health.configured:
        result["error_code"] = "missing_api_key"
        return result

    try:
        import asyncio

        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
        started = time.monotonic()
        resp = await asyncio.wait_for(
            client.chat.completions.create(
                model=health.model,
                messages=[
                    {"role": "system", "content": "Reply with the single word: ok"},
                    {"role": "user", "content": "ping"},
                ],
                max_tokens=5,
                temperature=0,
            ),
            timeout=timeout,
        )
        result["latency_ms"] = int((time.monotonic() - started) * 1000)
        content = (resp.choices[0].message.content or "").strip().lower()
        result["reachable"] = True
        result["ok"] = bool(content)
        result["usage"] = _extract_usage(resp)
    except Exception as exc:  # noqa: BLE001 — we only surface a safe code
        result["error_code"] = _safe_error_code(exc)
        result["reachable"] = False

    return result
