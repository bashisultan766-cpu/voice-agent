#!/usr/bin/env python3
"""Check Eric Agent Runtime configuration (v4.12). Safe — no secrets printed."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main() -> int:
    from app.config import get_settings
    from app.agent_runtime.eric_master_policy import build_eric_brain_system_prompt
    from app.agent_runtime.knowledge_base import is_knowledge_base_loaded
    from app.agent_runtime.worker_packet import READ_ONLY_WORKERS, MUTATING_WORKERS

    s = get_settings()
    policy = build_eric_brain_system_prompt()

    print("Eric Agent Runtime Check")
    print("=" * 40)
    print(f"Runtime mode:        {s.VOICE_AGENT_RUNTIME_MODE}")
    print(f"OpenAI configured:   {'yes' if bool(s.OPENAI_API_KEY) else 'no'}")
    print(f"Supervisor model:    {s.VOICE_SUPERVISOR_MODEL}")
    print(f"Final model:         {s.VOICE_FINAL_MODEL}")
    print(f"Memory turns:        {s.VOICE_MEMORY_TURNS}")
    print(f"LLM brain enabled:   {s.VOICE_LLM_BRAIN_ENABLED}")
    print(f"Final response mode: {s.VOICE_FINAL_RESPONSE_MODE}")
    print(f"Final LLM for unknown: {'yes' if s.VOICE_FINAL_LLM_FOR_UNKNOWN else 'no'}")
    print(f"Final LLM for small talk: {'yes' if s.VOICE_FINAL_LLM_FOR_SMALL_TALK else 'no'}")
    print(f"Welcome greeting enabled: {'yes' if s.VOICE_WELCOME_GREETING_ENABLED else 'no'}")
    print(f"Welcome greeting configured: {'yes' if bool(s.VOICE_WELCOME_GREETING.strip()) else 'no'}")
    print(f"TTS provider:        {s.VOICE_TTS_PROVIDER}")
    print(f"Policy loaded:       {'yes' if len(policy) > 100 else 'no'}")
    print(f"Knowledge base:      {'yes' if is_knowledge_base_loaded() else 'no'}")
    print(f"Read-only workers:   {', '.join(sorted(READ_ONLY_WORKERS))}")
    print(f"Mutating workers:    {', '.join(sorted(MUTATING_WORKERS))}")
    print(f"OpenAI tools live:   {'blocked' if s.VOICE_LIVE_DISABLE_OPENAI_TOOLS else 'ENABLED'}")
    print(f"Outbound text logging: {'yes' if s.VOICE_LOG_OUTBOUND_TEXT else 'no'}")
    print(f"CR text interruptible: {str(s.VOICE_CR_TEXT_INTERRUPTIBLE).lower()}")
    print(f"CR text preemptible:   {str(s.VOICE_CR_TEXT_PREEMPTIBLE).lower()}")
    print("=" * 40)
    print("No secrets, API keys, or prompts printed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
