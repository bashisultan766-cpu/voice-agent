#!/usr/bin/env python3
"""
Diagnostic for the LLM-first tool runtime. Safe — never prints secret VALUES,
only present/missing and structural checks.

Usage:
    python -m app.scripts.check_agent_runtime

Checks:
  * required env vars are present (value never printed)
  * OpenAI client initialises
  * Shopify client initialises / configured
  * Twilio config present
  * ElevenLabs config present (if used)
  * canonical tools are registered
  * master prompt loads
  * the single LLM-first runtime is the active handler (legacy disabled)

Exit code 0 = healthy; non-zero = one or more required checks failed.
"""
from __future__ import annotations

import sys


def _row(label: str, ok: bool, detail: str = "") -> tuple[str, bool]:
    mark = "OK " if ok else "XX "
    suffix = f"  ({detail})" if detail else ""
    return (f"{mark}{label:<34}{'present' if ok else 'MISSING'}{suffix}", ok)


def run() -> int:
    from app.config import get_settings

    settings = get_settings()
    lines: list[str] = []
    required_ok = True

    print("Agent Runtime Check (LLM-first tool runtime)")
    print("=" * 56)

    # ── Required env vars (presence only; values never printed) ───────────────
    required_env = {
        "OPENAI_API_KEY": settings.OPENAI_API_KEY,
        "SHOPIFY_SHOP_DOMAIN": settings.SHOPIFY_SHOP_DOMAIN,
        "SHOPIFY_ADMIN_ACCESS_TOKEN": settings.SHOPIFY_ADMIN_ACCESS_TOKEN,
        "TWILIO_ACCOUNT_SID": settings.TWILIO_ACCOUNT_SID,
        "TWILIO_AUTH_TOKEN": settings.TWILIO_AUTH_TOKEN,
    }
    for name, val in required_env.items():
        line, ok = _row(name, bool(val))
        lines.append(line)
        required_ok = required_ok and ok

    # ── Optional integrations ─────────────────────────────────────────────────
    optional_env = {
        "ELEVENLABS_API_KEY": settings.ELEVENLABS_API_KEY,
        "RESEND_API_KEY": settings.RESEND_API_KEY,
        "REDIS_URL": settings.REDIS_URL,
    }
    for name, val in optional_env.items():
        lines.append(_row(f"{name} (optional)", bool(val))[0])

    # ── Component initialisation ──────────────────────────────────────────────
    def _check(label: str, fn, required: bool = True) -> None:
        nonlocal required_ok
        try:
            ok, detail = fn()
        except Exception as exc:  # noqa: BLE001 — report safe class name only
            ok, detail = False, type(exc).__name__
        lines.append(_row(label, ok, detail)[0])
        if required:
            required_ok = required_ok and ok

    def _openai_client():
        # Build the client through the runtime (keeps the openai import inside
        # app/agent_runtime/, the single LLM layer).
        from app.agent_runtime.llm_tool_runtime import LLMToolRuntime

        LLMToolRuntime(settings=settings)._get_client()
        return bool(settings.OPENAI_API_KEY), settings.OPENAI_MODEL

    def _shopify_client():
        from app.shopify.client import get_shopify_client

        client = get_shopify_client()
        return bool(getattr(client, "configured", False)), "configured" if getattr(client, "configured", False) else "not configured"

    def _twilio_cfg():
        return bool(settings.TWILIO_ACCOUNT_SID and settings.TWILIO_AUTH_TOKEN), ""

    def _elevenlabs_cfg():
        return bool(settings.ELEVENLABS_API_KEY or settings.VOICE_ID), settings.VOICE_TTS_PROVIDER

    def _tools_registered():
        from app.agent_runtime import llm_tools

        names = llm_tools.tool_names()
        return len(names) >= 17, f"{len(names)} tools"

    def _master_prompt():
        from app.agent_runtime.master_prompt import load_master_prompt

        mp = load_master_prompt()
        return bool(mp.text), f"{mp.approx_tokens} tokens, {len(mp.sections)} sections"

    def _active_runtime():
        from app.agent_runtime.runtime import resolve_live_turn_handler
        from app.agent_runtime.llm_tool_runtime import RUNTIME_MODE

        handler = resolve_live_turn_handler(settings)
        return handler == RUNTIME_MODE, handler

    def _legacy_disabled():
        from app.agent_runtime.legacy_disabled import QUARANTINED_MODULES, ACTIVE_RUNTIME

        return ACTIVE_RUNTIME.endswith("llm_tool_runtime"), f"{len(QUARANTINED_MODULES)} quarantined"

    print()
    _check("OpenAI client init", _openai_client)
    _check("Shopify client init", _shopify_client, required=False)
    _check("Twilio config", _twilio_cfg)
    _check("ElevenLabs config (optional)", _elevenlabs_cfg, required=False)
    _check("Canonical tools registered", _tools_registered)
    _check("Master prompt loads", _master_prompt)
    _check("Active runtime = LLM_TOOL_RUNTIME", _active_runtime)
    _check("Legacy runtime disabled", _legacy_disabled)

    for line in lines:
        print(line)

    print("=" * 56)
    print("No secret values were printed - presence/structure only.")
    if not required_ok:
        print("FAIL: one or more required checks are missing.")
        return 1
    print("OK: runtime is configured and the LLM-first tool runtime is active.")
    return 0


def main() -> int:
    try:
        return run()
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
