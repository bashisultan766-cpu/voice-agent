#!/usr/bin/env python3
"""
Verify the OpenAI runtime is usable. Safe — never prints keys, prompts, or PII.

Usage:
    python -m app.scripts.check_openai_runtime

Exit code 0 = healthy; non-zero = fail loudly (missing key / model / quota).
"""
from __future__ import annotations

import asyncio
import sys


def _print_kv(label: str, value: str) -> None:
    print(f"{label:<24}{value}")


async def _run() -> int:
    from app.config import get_settings
    from app.agent_runtime.openai_health import get_health, run_openai_check

    settings = get_settings()
    health = get_health(settings)

    print("OpenAI Runtime Check")
    print("=" * 40)
    _print_kv("API key present:", "yes" if health.configured else "NO")
    _print_kv("Key source:", health.key_source)
    _print_kv("Model:", health.model)

    if not health.configured:
        print("=" * 40)
        print("FAIL: OPENAI_API_KEY is missing. The LLM brain cannot answer.")
        print("Set OPENAI_API_KEY in .env (never commit it) and retry.")
        return 2

    print("Testing a tiny completion...")
    result = await run_openai_check(settings)

    _print_kv("Model reachable:", "yes" if result["reachable"] else "NO")
    if result.get("latency_ms") is not None:
        _print_kv("Latency:", f"{result['latency_ms']} ms")
    usage = result.get("usage") or {}
    if usage.get("total_tokens") is not None:
        _print_kv("Tokens (total):", str(usage["total_tokens"]))

    print("=" * 40)
    print("No secrets, API keys, or prompts printed.")

    if not result["ok"]:
        code = result.get("error_code") or "unknown_error"
        print(f"FAIL: OpenAI test completion failed (error_code={code}).")
        if code in ("401", "403"):
            print("Check the API key validity / model access for this account.")
        elif code in ("429",):
            print("Quota or rate limit hit. Check billing/usage limits.")
        elif code == "missing_api_key":
            print("OPENAI_API_KEY is missing.")
        return 3

    print("OK: OpenAI is configured, model is reachable, completion succeeded.")
    return 0


def main() -> int:
    try:
        return asyncio.run(_run())
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
