#!/usr/bin/env python3
"""Check Eric Agent Runtime configuration (v4.14). Safe — no secrets printed."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main() -> int:
    from app.config import get_settings
    from app.agent_runtime.prompt_loader import get_prompt_load_status, load_eric_system_prompt_text
    from app.agent_runtime.knowledge_base import is_knowledge_base_loaded
    from app.agent_runtime.worker_packet import READ_ONLY_WORKERS, MUTATING_WORKERS
    from app.agent_runtime.main_llm_agent import AVAILABLE_TOOL_CATEGORIES

    s = get_settings()
    load_eric_system_prompt_text()
    prompt_status = get_prompt_load_status()
    policy_len = prompt_status["chars"]

    is_main_llm = s.VOICE_AGENT_RUNTIME_MODE == "main_llm_agent"

    print("Eric Agent Runtime Check (v4.14.3)")
    print("=" * 40)
    print(f"Agent runtime mode:     {s.VOICE_AGENT_RUNTIME_MODE}")
    print(f"Eric prompt file:       {'loaded' if prompt_status['loaded_from_file'] else 'inline_fallback'}")
    print(f"Eric prompt chars:      {prompt_status['chars']}")
    print(f"Main LLM agent:         {'enabled' if is_main_llm else 'disabled'}")
    print(f"Direct answer path:     {'enabled' if is_main_llm else 'via_supervisor'}")
    print(f"Tool fanout after LLM:  {'enabled' if is_main_llm else 'via_supervisor'}")
    print(f"OpenAI configured:      {'yes' if bool(s.OPENAI_API_KEY) else 'no'}")
    print(f"Supervisor model:       {s.VOICE_SUPERVISOR_MODEL}")
    print(f"Main LLM timeout:       {s.VOICE_MAIN_LLM_TIMEOUT_MS}ms")
    print(f"Final model:            {s.VOICE_FINAL_MODEL}")
    print(f"Memory turns:           {s.VOICE_MEMORY_TURNS}")
    print(f"LLM brain enabled:      {s.VOICE_LLM_BRAIN_ENABLED}")
    print(f"Final response mode:    {s.VOICE_FINAL_RESPONSE_MODE}")
    print(f"Welcome greeting:       {'enabled' if s.VOICE_WELCOME_GREETING_ENABLED else 'disabled'}")
    print(f"TTS provider:           {s.VOICE_TTS_PROVIDER}")
    print(f"Policy loaded:          {'yes' if policy_len > 100 else 'no'}")
    print(f"Eric prompt version:    {prompt_status['version']}")
    print(f"Knowledge base:         {'yes' if is_knowledge_base_loaded() else 'no'}")
    print(f"Read-only workers:      {', '.join(sorted(READ_ONLY_WORKERS))}")
    print(f"Mutating workers:       {', '.join(sorted(MUTATING_WORKERS))}")
    print(f"Available tool cats:    {', '.join(sorted(AVAILABLE_TOOL_CATEGORIES))}")
    print(f"OpenAI tools live:      {'blocked' if s.VOICE_LIVE_DISABLE_OPENAI_TOOLS else 'ENABLED'}")
    print(f"Outbound text logging:  {'yes' if s.VOICE_LOG_OUTBOUND_TEXT else 'no'}")
    print("=" * 40)
    print("No secrets, API keys, or prompts printed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
